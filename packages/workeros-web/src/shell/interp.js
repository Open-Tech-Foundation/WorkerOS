// wsh interpreter — a tree-walking evaluator over the parser's AST.
//
// This is where the shell's *runtime* lives: parameter/command/arithmetic
// expansion with field-splitting and globbing, the control-flow constructs, and
// the builtins that have no external program (`test`/`[`, `read`, `export`,
// `local`, `printf`, `set`, `trap`, `cd`, …). External commands and all VFS/glob
// access are delegated to a `runtime` object so this module is pure logic and can
// be unit-tested in Node with a mock runtime.
//
// runtime interface (all may be async):
//   runExternal({argv, env, cwd, stdin, redirects, out, err}) -> exitCode
//   readFile(path, cwd)  -> Uint8Array | null
//   writeFile(path, cwd, bytes, append) -> void
//   statPath(path, cwd)  -> { isFile, isDir } | null
//   glob(pattern, cwd)   -> string[]                (empty => no match)
//   resolveDir(cwd, target) -> absolute dir (throws if missing)
//   readLine()           -> string | null           (interactive `read`; EOF => null)


const enc = new TextEncoder();
const dec = new TextDecoder();
const IFS_WS = new Set([" ", "\t", "\n"]);

class ExitSignal { constructor(code) { this.code = code; } }
class ReturnSignal { constructor(code) { this.code = code; } }
class BreakSignal { constructor(n) { this.n = n; } }
class ContinueSignal { constructor(n) { this.n = n; } }

// A shared, mutable cursor over piped/redirected stdin. Passed by reference so
// successive `read` calls (e.g. inside `while read line`) advance the same input.
export class StdinReader {
  constructor(bytes) { this.s = bytes ? dec.decode(bytes) : ""; this.pos = 0; }
  eof() { return this.pos >= this.s.length; }
  readLine() {
    if (this.pos >= this.s.length) return null;
    const nl = this.s.indexOf("\n", this.pos);
    if (nl < 0) { const r = this.s.slice(this.pos); this.pos = this.s.length; return r; }
    const r = this.s.slice(this.pos, nl); this.pos = nl + 1; return r;
  }
  readAll() { const r = this.s.slice(this.pos); this.pos = this.s.length; return enc.encode(r); }
}

export function createInterpreter({ runtime, session }) {
  // Shell state. `vars` is the global scope; `scopes` is the `local` stack.
  const state = {
    vars: new Map(Object.entries(session.env || {})),
    exported: new Set(Object.keys(session.env || {})),
    funcs: new Map(),
    params: [], // positional parameters $1, $2, …
    status: 0, // $?
    opts: { errexit: false, nounset: false, xtrace: false },
    traps: new Map(), // signal name -> command string
    scopes: [], // array of Map(name -> previous value | undefined) for `local`
  };

  // ---- variable access -----------------------------------------------------
  const getVar = (name) => {
    if (state.vars.has(name)) return state.vars.get(name);
    return undefined;
  };
  const setVar = (name, value) => {
    // If a `local` scope declared this name, the write stays visible globally but
    // is restored on function return (handled by the scope snapshot).
    state.vars.set(name, value);
  };

  // ---- word expansion ------------------------------------------------------

  // Expand a WORD token to a list of fields (argv contributions).
  // When splitFields is false (assignments, redirect targets, case words), the
  // result is exactly one string with no splitting or globbing.
  async function expandWord(word, splitFields = true) {
    const chunks = []; // { text, split, anchor, globbable }
    for (const part of word.parts) {
      switch (part.kind) {
        case "lit":
          chunks.push({ text: part.value, split: false, anchor: false, globbable: word.globbable });
          break;
        case "sq":
          chunks.push({ text: part.value, split: false, anchor: true, globbable: false });
          break;
        case "param": {
          const v = await expandParam(part.src);
          chunks.push({ text: v, split: !part.quoted, anchor: part.quoted, globbable: false });
          break;
        }
        case "cmdsub": {
          const out = await captureSubshell(part.src);
          const trimmed = out.replace(/\n+$/, "");
          chunks.push({ text: trimmed, split: !part.quoted, anchor: part.quoted, globbable: false });
          break;
        }
        case "arith": {
          const n = await evalArith(part.src);
          chunks.push({ text: String(n), split: false, anchor: false, globbable: false });
          break;
        }
        default:
          chunks.push({ text: "", split: false, anchor: false, globbable: false });
      }
    }

    if (!splitFields) {
      return [chunks.map((c) => c.text).join("")];
    }

    // Field splitting on IFS whitespace, honoring quoted (non-split) chunks.
    const fields = [];
    let cur = "";
    let open = false;
    const close = () => { if (open) { fields.push(cur); cur = ""; open = false; } };
    for (const chunk of chunks) {
      if (!chunk.split) {
        cur += chunk.text;
        if (chunk.text !== "" || chunk.anchor) open = true;
      } else {
        let seg = "";
        for (const c of chunk.text) {
          if (IFS_WS.has(c)) {
            if (seg) { cur += seg; open = true; seg = ""; }
            close();
          } else seg += c;
        }
        if (seg) { cur += seg; open = true; }
      }
    }
    close();

    // Globbing: expand fields whose word carried an unquoted glob metachar.
    if (!word.globbable) return fields;
    const out = [];
    for (const f of fields) {
      if (/[*?[]/.test(f)) {
        const matches = await runtime.glob(f, session.cwd);
        if (matches && matches.length) { out.push(...matches); continue; }
      }
      out.push(f);
    }
    return out;
  }

  // ${...} parameter expansion (the common operators).
  async function expandParam(src) {
    // Length: ${#name}
    if (src.startsWith("#") && src.length > 1) {
      const name = src.slice(1);
      if (name === "@" || name === "*") return String(state.params.length);
      return String((simpleParam(name) ?? "").length);
    }
    // Find operator: :- := :? :+ or - = ? + (unset-only) or # ## % %% / //  or :off:len
    const m = src.match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!])(.*)$/s);
    if (!m) return "";
    const name = m[1];
    const rest = m[2];
    const raw = simpleParam(name);

    if (rest === "") return raw ?? "";

    // Pattern-strip and replace.
    if (rest[0] === "#" || rest[0] === "%") {
      const greedy = rest[1] === rest[0];
      const pat = rest.slice(greedy ? 2 : 1);
      return stripPattern(raw ?? "", pat, rest[0], greedy);
    }
    if (rest[0] === "/") {
      const all = rest[1] === "/";
      const body = rest.slice(all ? 2 : 1);
      const slash = splitReplace(body);
      return replacePattern(raw ?? "", slash.pat, slash.rep, all);
    }
    // Substring: ${name:offset} / ${name:offset:len} — but distinguish from :-,:=,:?,:+
    if (rest[0] === ":" && rest[1] !== undefined && "-=?+".includes(rest[1]) === false) {
      const spec = rest.slice(1);
      const parts = spec.split(":");
      const s = raw ?? "";
      let off = parseInt(parts[0], 10) || 0;
      if (off < 0) off = Math.max(0, s.length + off);
      if (parts.length > 1) { const len = parseInt(parts[1], 10); return s.substr(off, len); }
      return s.slice(off);
    }
    // Default / assign / error / alternate — with (`:`) or without null-check.
    const colon = rest[0] === ":";
    const opCh = colon ? rest[1] : rest[0];
    const arg = rest.slice(colon ? 2 : 1);
    const unset = raw === undefined;
    const nullish = unset || (colon && raw === "");
    switch (opCh) {
      case "-": return nullish ? (await expandToString(arg)) : raw;
      case "=": {
        if (nullish) { const v = await expandToString(arg); setVar(name, v); return v; }
        return raw;
      }
      case "?": {
        if (nullish) throw new ExitSignal(1); // param null/unset → error (simplified)
        return raw;
      }
      case "+": return nullish ? "" : (await expandToString(arg));
      default: return raw ?? "";
    }
  }

  // Resolve a "simple" parameter name to its string value (or undefined).
  function simpleParam(name) {
    switch (name) {
      case "?": return String(state.status);
      case "#": return String(state.params.length);
      case "@":
      case "*": return state.params.join(" ");
      case "$": return "1"; // no real pid; stable placeholder
      case "!": return "";
      case "0": return session.env.WSH_ARGV0 || "wsh";
      default:
        if (/^[0-9]+$/.test(name)) return state.params[parseInt(name, 10) - 1];
        if (state.opts.nounset && !state.vars.has(name)) throw new ExitSignal(1);
        return getVar(name);
    }
  }

  // Expand an operator argument (may itself contain $… ), no field splitting.
  async function expandToString(text) {
    if (!text.includes("$") && !text.includes("`")) return text;
    return await expandFragment(text);
  }

  // Minimal inline expander for operator arguments: handles $name, ${name}, $(...).
  async function expandFragment(text) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "$") {
        if (text[i + 1] === "{") {
          const end = text.indexOf("}", i);
          out += await expandParam(text.slice(i + 2, end));
          i = end;
        } else if (text[i + 1] === "(") {
          let depth = 1, j = i + 2;
          while (j < text.length && depth) { if (text[j] === "(") depth++; else if (text[j] === ")") depth--; if (!depth) break; j++; }
          out += (await captureSubshell(text.slice(i + 2, j))).replace(/\n+$/, "");
          i = j;
        } else {
          const mm = text.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*|^[0-9]+|^[?#@*]/);
          if (mm) { out += simpleParam(mm[0]) ?? ""; i += mm[0].length; }
          else out += "$";
        }
      } else out += c;
    }
    return out;
  }

  function splitReplace(body) {
    // Split ${x/pat/rep} on the first unescaped '/'.
    let idx = body.indexOf("/");
    if (idx < 0) return { pat: body, rep: "" };
    return { pat: body.slice(0, idx), rep: body.slice(idx + 1) };
  }

  function patternToRegex(pat) {
    // Translate a shell glob pattern to a RegExp source.
    let re = "";
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === "*") re += ".*";
      else if (c === "?") re += ".";
      else if (c === "[") {
        let j = i + 1, cls = "[";
        if (pat[j] === "!") { cls += "^"; j++; }
        while (j < pat.length && pat[j] !== "]") { cls += pat[j]; j++; }
        cls += "]"; re += cls; i = j;
      } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return re;
  }

  function stripPattern(value, pat, side, greedy) {
    const re = patternToRegex(pat);
    if (side === "#") {
      const r = new RegExp("^" + (greedy ? "(" + re + ")" : "(" + re + "?)"));
      // shortest vs longest prefix
      if (greedy) { const m = value.match(new RegExp("^" + re)); return m ? value.slice(m[0].length) : value; }
      // shortest: try increasing lengths
      for (let k = 0; k <= value.length; k++) {
        if (new RegExp("^" + re + "$").test(value.slice(0, k))) return value.slice(k);
      }
      return value;
    } else {
      if (greedy) { const m = value.match(new RegExp(re + "$")); return m ? value.slice(0, value.length - m[0].length) : value; }
      for (let k = value.length; k >= 0; k--) {
        if (new RegExp("^" + re + "$").test(value.slice(k))) return value.slice(0, k);
      }
      return value;
    }
  }

  function replacePattern(value, pat, rep, all) {
    const re = new RegExp(patternToRegex(pat), all ? "g" : "");
    return value.replace(re, rep.replace(/\$/g, "$$$$"));
  }

  // ---- arithmetic ----------------------------------------------------------
  async function evalArith(src) {
    const expanded = await expandFragment(src);
    return arith(expanded, (name) => {
      const v = getVar(name);
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? 0 : n;
    }, (name, val) => setVar(name, String(val)));
  }

  // ---- execution -----------------------------------------------------------

  // Run a parsed list ({type:"list", items:[andor]}) sequentially.
  async function runList(list, io) {
    let code = 0;
    for (const ao of list.items) {
      if (ao.background) {
        // Detach: the job runs without blocking the rest of the list.
        runAndOr(ao, io).catch(() => {});
        code = 0;
        continue;
      }
      code = await runAndOr(ao, io);
      // errexit fires on a failed *simple* statement, not one used as a condition
      // or joined by && / || (those consume the failure themselves).
      if (state.opts.errexit && code !== 0 && !ao._condition && ao.pipelines.length === 1) {
        throw new ExitSignal(code);
      }
    }
    return code;
  }

  async function runAndOr(ao, io) {
    let code = 0;
    let skip = false;
    for (let k = 0; k < ao.pipelines.length; k++) {
      const { op, pipeline } = ao.pipelines[k];
      if (k > 0) {
        if (op === "&&" && code !== 0) { skip = true; }
        else if (op === "||" && code === 0) { skip = true; }
        else skip = false;
      }
      if (skip) continue;
      code = await runPipeline(pipeline, io);
    }
    state.status = code;
    return code;
  }

  async function runPipeline(pipeline, io) {
    const cmds = pipeline.commands;
    let code;
    if (cmds.length === 1) {
      code = await runCommand(cmds[0], io);
    } else if (runtime.pipeOpen && cmds.every(isPlainExternal)) {
      // (Guarded on the runtime hook so an embedder's reduced runtime — e.g.
      // the interpreter unit tests' mock — keeps the collect-and-feed path.)
      // All stages are external programs: run them *concurrently* over real
      // kernel pipes (ADR-023). Streaming and bounded — a fast producer blocks
      // when the pipe fills, and a stage whose reader exits gets EPIPE/SIGPIPE
      // (so `producer | head`-style pipelines terminate), exactly like POSIX.
      code = await runPipedExternals(cmds, io);
    } else {
      // "collect and feed": each stage's captured stdout becomes the next stdin.
      // Not concurrent/streaming, but lets builtins and externals interoperate.
      let stdin = io.stdin || null; // a StdinReader (shared, mutable) or null
      for (let k = 0; k < cmds.length; k++) {
        const last = k === cmds.length - 1;
        if (last) {
          code = await runCommand(cmds[k], { ...io, stdin });
        } else {
          const buf = [];
          code = await runCommand(cmds[k], { ...io, stdin, out: (b) => buf.push(b) });
          stdin = new StdinReader(concat(buf));
        }
      }
    }
    if (pipeline.negate) code = code === 0 ? 1 : 0;
    state.status = code;
    return code;
  }

  /** The command name of a simple command when it is statically known (all
   *  literal/single-quoted parts, no glob metachars) — else null. Used to pick
   *  the streaming pipeline path without running expansions twice. */
  function staticCommandName(cmd) {
    if (cmd.type !== "simple" || !cmd.words || cmd.words.length === 0) return null;
    let name = "";
    for (const part of cmd.words[0].parts) {
      if (part.kind === "lit" || part.kind === "sq") name += part.value;
      else return null; // $var / $(...) command word: expansion decides — fall back
    }
    return /[*?[]/.test(name) ? null : name;
  }

  /** Whether a pipeline stage is certainly an external program (not a builtin,
   *  function, or compound command). Conservative: unknown ⇒ false. */
  function isPlainExternal(cmd) {
    const name = staticCommandName(cmd);
    return name !== null && !BUILTINS[name] && !state.funcs.has(name);
  }

  /** Run an all-external pipeline over kernel pipes, all stages concurrent.
   *  Spawn order is writer-before-reader (the kernel treats a pipe end that was
   *  never attached as "not final yet"). Exit code is the last stage's (no
   *  pipefail). Stage k's stdout feeds k+1's stdin; redirects still win. */
  async function runPipedExternals(cmds, io) {
    const n = cmds.length;
    const pipeIds = [];
    for (let i = 0; i < n - 1; i++) pipeIds.push(runtime.pipeOpen());
    // One process group for the whole pipeline (ADR-025): the first stage
    // becomes leader + the terminal's foreground group, the rest join it —
    // unless this shell run acts for a process (sys.exec), which keeps its own.
    const pgroup = session.spawnPpid ? undefined : { leader: 0 };
    const waits = [];
    for (let i = 0; i < n; i++) {
      const cmd = cmds[i];
      // Per-stage expansion, exactly as runSimple's external branch (once).
      const argv = [];
      for (const w of cmd.words) argv.push(...(await expandWord(w, true)));
      const localEnv = {};
      for (const a of cmd.assigns) localEnv[a.name] = (await expandWord(a.word, false))[0];
      const redirects = [];
      for (const r of cmd.redirects || []) {
        redirects.push({ fd: r.fd, op: r.op, target: (await expandWord(r.target, false))[0] });
      }
      const env = { ...Object.fromEntries(state.vars), ...envExports(), ...localEnv };
      // Not awaited here: the process is spawned synchronously inside
      // runExternal, so stage i (writer) attaches before i+1 (reader) and all
      // stages run concurrently; only the exits are awaited together below.
      waits.push(runtime.runExternal({
        argv, env, cwd: session.cwd,
        stdin: i === 0 && io.stdin ? io.stdin.readAll() : null,
        stdinPipe: i > 0 ? pipeIds[i - 1] : null,
        stdoutPipe: i < n - 1 ? pipeIds[i] : null,
        redirects, out: io.out, err: io.err, ppid: session.spawnPpid || 0,
        pgroup,
      }));
    }
    const codes = await Promise.all(waits);
    return codes[n - 1] | 0;
  }

  async function runCommand(cmd, io) {
    switch (cmd.type) {
      case "simple": return runSimple(cmd, io);
      case "if": return withRedirects(cmd, io, runIf);
      case "for": return withRedirects(cmd, io, runFor);
      case "while": return withRedirects(cmd, io, runWhile);
      case "case": return withRedirects(cmd, io, runCase);
      case "group": return withRedirects(cmd, io, (c, x) => runList(c.body, x));
      case "subshell": return withRedirects(cmd, io, runSubshell);
      case "func": state.funcs.set(cmd.name, cmd.body); return 0;
      default: throw new Error("unknown command node: " + cmd.type);
    }
  }

  // Apply a compound command's redirects around its execution.
  async function withRedirects(cmd, io, fn) {
    const redirects = cmd.redirects || [];
    if (redirects.length === 0) return fn(cmd, io);
    const eff = await applyRedirects(redirects, io);
    const code = await fn(cmd, eff.io);
    await eff.finish(code);
    return code;
  }

  // Build an effective io from redirects (for builtins/compounds). Returns an io
  // whose out/err/stdin reflect file/dup redirects, plus a finish() to flush.
  async function applyRedirects(redirects, io) {
    let out = io.out, err = io.err, stdin = io.stdin;
    const fileBufs = []; // { path, append, chunks }
    for (const r of redirects) {
      const target = (await expandWord(r.target, false))[0];
      const fd = r.fd ?? (r.op.includes("<") ? 0 : 1);
      if (r.op.endsWith("&")) {
        // fd duplication: 2>&1, 1>&2, >&-
        if (target === "1") { if (fd === 2) err = (b) => out(b); }
        else if (target === "2") { if (fd === 1) out = (b) => err(b); }
        continue;
      }
      if (r.op === "<") { const bytes = await runtime.readFile(target, session.cwd); stdin = new StdinReader(bytes || new Uint8Array(0)); continue; }
      if (r.op === ">" || r.op === ">>") {
        if (target === "/dev/null") { const sink = () => {}; if (fd === 2) err = sink; else out = sink; continue; }
        const rec = { path: target, append: r.op === ">>", chunks: [] };
        fileBufs.push(rec);
        const w = (b) => rec.chunks.push(b);
        if (fd === 2) err = w; else out = w;
        continue;
      }
    }
    const finish = async (code) => {
      for (const fb of fileBufs) await runtime.writeFile(fb.path, session.cwd, concat(fb.chunks), fb.append);
      return code;
    };
    return { io: { ...io, out, err, stdin }, finish };
  }

  async function runIf(cmd, io) {
    for (const clause of cmd.clauses) {
      clause.cond._condition = true;
      const c = await runList({ ...clause.cond, items: markCond(clause.cond.items) }, io);
      if (c === 0) return runList(clause.body, io);
    }
    if (cmd.elseBody) return runList(cmd.elseBody, io);
    return 0;
  }
  function markCond(items) { for (const it of items) it._condition = true; return items; }

  async function runFor(cmd, io) {
    const values = [];
    if (cmd.words === null) values.push(...state.params);
    else for (const w of cmd.words) values.push(...(await expandWord(w, true)));
    let code = 0;
    for (const v of values) {
      setVar(cmd.var, v);
      try { code = await runList(cmd.body, io); }
      catch (e) { if (e instanceof BreakSignal) { if (--e.n > 0) throw e; break; } if (e instanceof ContinueSignal) { if (--e.n > 0) throw e; continue; } throw e; }
    }
    return code;
  }

  async function runWhile(cmd, io) {
    let code = 0;
    for (let guard = 0; guard < 1e6; guard++) {
      const c = await runList({ ...cmd.cond, items: markCond(cmd.cond.items) }, io);
      const go = cmd.until ? c !== 0 : c === 0;
      if (!go) break;
      try { code = await runList(cmd.body, io); }
      catch (e) { if (e instanceof BreakSignal) { if (--e.n > 0) throw e; break; } if (e instanceof ContinueSignal) { if (--e.n > 0) throw e; continue; } throw e; }
    }
    return code;
  }

  async function runCase(cmd, io) {
    const subject = (await expandWord(cmd.word, false))[0];
    for (const item of cmd.items) {
      for (const pat of item.patterns) {
        const p = (await expandWord(pat, false))[0];
        if (new RegExp("^" + patternToRegex(p) + "$").test(subject)) {
          return runList(item.body, io);
        }
      }
    }
    return 0;
  }

  async function runSubshell(cmd, io) {
    // A real subshell isolates state; we snapshot and restore the essentials.
    const snap = { vars: new Map(state.vars), params: [...state.params], cwd: session.cwd };
    try { return await runList(cmd.body, io); }
    finally { state.vars = snap.vars; state.params = snap.params; session.cwd = snap.cwd; }
  }

  // ---- simple command ------------------------------------------------------
  async function runSimple(cmd, io) {
    // Expand argv.
    const argv = [];
    for (const w of cmd.words) argv.push(...(await expandWord(w, true)));

    // Pure assignment (no command word): set shell vars.
    if (argv.length === 0) {
      for (const a of cmd.assigns) {
        const val = (await expandWord(a.word, false))[0];
        setVar(a.name, val);
      }
      // A bare assignment still runs redirects (rare) and yields 0.
      return 0;
    }

    // Assignments preceding a command apply to that command's environment only.
    const localEnv = {};
    for (const a of cmd.assigns) localEnv[a.name] = (await expandWord(a.word, false))[0];

    const name = argv[0];
    let code;

    if (state.funcs.has(name) || BUILTINS[name]) {
      // Builtins and functions run in-process: honor redirects via JS buffering.
      const eff = await applyRedirects(cmd.redirects || [], io);
      const rio = eff.io;
      if (state.funcs.has(name)) code = await callFunction(name, argv.slice(1), rio);
      else code = await BUILTINS[name](argv.slice(1), rio, localEnv);
      await eff.finish(code);
    } else {
      // External program: pass expanded redirects through so the host can build a
      // streaming stdio plan (file writes, 2>&1, /dev/null) natively.
      const redirects = [];
      for (const r of cmd.redirects || []) {
        redirects.push({ fd: r.fd, op: r.op, target: (await expandWord(r.target, false))[0] });
      }
      const env = { ...Object.fromEntries(state.vars), ...envExports(), ...localEnv };
      code = await runtime.runExternal({
        argv, env, cwd: session.cwd, stdin: io.stdin ? io.stdin.readAll() : null,
        redirects, out: io.out, err: io.err, ppid: session.spawnPpid || 0,
        // Interactive commands become their own foreground job (a fresh process
        // group); commands run on behalf of a process (`sys.exec`, npm run —
        // spawnPpid set) stay inside the caller's group, as a non-interactive
        // POSIX shell would (ADR-025).
        pgroup: session.spawnPpid ? undefined : { leader: 0 },
      });
    }
    state.status = code;
    return code;
  }

  function envExports() {
    const e = {};
    for (const k of state.exported) if (state.vars.has(k)) e[k] = state.vars.get(k);
    return e;
  }

  async function callFunction(name, args, io) {
    const body = state.funcs.get(name);
    const savedParams = state.params;
    const scope = new Map(); // name -> previous value (for `local`)
    state.scopes.push(scope);
    state.params = args;
    try {
      return await runCommand(body, io);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.code;
      throw e;
    } finally {
      // Restore locals declared in this frame.
      for (const [k, prev] of scope) { if (prev === undefined) state.vars.delete(k); else state.vars.set(k, prev); }
      state.scopes.pop();
      state.params = savedParams;
    }
  }

  // Run a command string captured for $( ) — returns its stdout as a string.
  async function captureSubshell(src) {
    const ast = runtime.parse(src);
    const buf = [];
    const io = { stdin: null, out: (b) => buf.push(b), err: (b) => (mainIo ? mainIo.err(b) : void 0) };
    await runList(ast, io);
    return dec.decode(concat(buf));
  }

  // ---- builtins ------------------------------------------------------------
  const writeOut = (io, s) => io.out(enc.encode(s));
  const writeErr = (io, s) => io.err(enc.encode(s));

  const BUILTINS = {
    ":": async () => 0,
    "true": async () => 0,
    "false": async () => 1,
    "echo": async (args, io) => {
      let nl = true, interpret = false, a = args;
      // Leading option groups: -n, -e, -E (combos like -ne). Anything else is an operand.
      while (a.length && /^-[neE]+$/.test(a[0])) {
        const f = a[0].slice(1);
        if (f.includes("n")) nl = false;
        if (f.includes("e")) interpret = true;
        if (f.includes("E")) interpret = false;
        a = a.slice(1);
      }
      let s = a.join(" ");
      if (interpret) {
        const r = echoEscapes(s);
        s = r.text;
        if (r.stop) nl = false; // \c: suppress the rest and the trailing newline
      }
      writeOut(io, s + (nl ? "\n" : ""));
      return 0;
    },
    "printf": async (args, io) => {
      const fmt = args[0] ?? "";
      const rest = args.slice(1);
      writeOut(io, sprintf(fmt, rest));
      return 0;
    },
    "pwd": async (args, io) => { writeOut(io, session.cwd + "\n"); return 0; },
    "cd": async (args, io) => {
      const target = args[0] || getVar("HOME") || "/";
      try { session.cwd = runtime.resolveDir(session.cwd, target); setVar("PWD", session.cwd); return 0; }
      catch { writeErr(io, "cd: " + target + ": No such file or directory\n"); return 1; }
    },
    "export": async (args) => {
      for (const a of args) {
        const eq = a.indexOf("=");
        if (eq >= 0) { const n = a.slice(0, eq); setVar(n, a.slice(eq + 1)); state.exported.add(n); }
        else state.exported.add(a);
      }
      return 0;
    },
    "unset": async (args) => { for (const a of args) { state.vars.delete(a); state.funcs.delete(a); state.exported.delete(a); } return 0; },
    "local": async (args) => {
      const scope = state.scopes[state.scopes.length - 1];
      for (const a of args) {
        const eq = a.indexOf("=");
        const n = eq >= 0 ? a.slice(0, eq) : a;
        if (scope && !scope.has(n)) scope.set(n, state.vars.has(n) ? state.vars.get(n) : undefined);
        if (eq >= 0) setVar(n, a.slice(eq + 1));
      }
      return 0;
    },
    "shift": async (args) => { const n = args[0] ? parseInt(args[0], 10) : 1; state.params = state.params.slice(n); return 0; },
    "exit": async (args) => { throw new ExitSignal(args[0] !== undefined ? parseInt(args[0], 10) & 255 : state.status); },
    "return": async (args) => { throw new ReturnSignal(args[0] !== undefined ? parseInt(args[0], 10) & 255 : state.status); },
    "break": async (args) => { throw new BreakSignal(args[0] ? parseInt(args[0], 10) : 1); },
    "continue": async (args) => { throw new ContinueSignal(args[0] ? parseInt(args[0], 10) : 1); },
    "read": async (args, io) => {
      // read [-r] [name...] — split a line on IFS whitespace into names.
      let names = args.filter((a) => a !== "-r");
      let line;
      if (io.stdin) line = io.stdin.readLine();
      else line = await runtime.readLine();
      if (line == null) return 1; // EOF
      if (names.length === 0) names = ["REPLY"];
      const fields = line.trim().split(/[ \t]+/);
      for (let k = 0; k < names.length; k++) {
        if (k === names.length - 1) setVar(names[k], fields.slice(k).join(" "));
        else setVar(names[k], fields[k] ?? "");
      }
      return 0;
    },
    "test": async (args, io) => testBuiltin(args, io, false),
    "[": async (args, io) => testBuiltin(args, io, true),
    "[[": async (args, io) => testBuiltin(args.filter((a) => a !== "]]"), io, false),
    "set": async (args) => {
      let i = 0;
      for (; i < args.length; i++) {
        const a = args[i];
        if (a === "--") { i++; break; }
        if (a[0] === "-" || a[0] === "+") {
          const on = a[0] === "-";
          for (const f of a.slice(1)) {
            if (f === "e") state.opts.errexit = on;
            else if (f === "u") state.opts.nounset = on;
            else if (f === "x") state.opts.xtrace = on;
          }
        } else break;
      }
      if (args[i] !== undefined && (args[i - 1] === "--" || !/^[-+]/.test(args[i]))) {
        state.params = args.slice(i);
      }
      return 0;
    },
    "trap": async (args) => {
      // trap 'cmd' SIG...  (we honor EXIT; others are stored but rarely fire)
      const cmd = args[0];
      for (const sig of args.slice(1)) state.traps.set(sig.toUpperCase(), cmd);
      return 0;
    },
    "eval": async (args, io) => {
      const ast = runtime.parse(args.join(" "));
      return runList(ast, io);
    },
    "source": async (args, io) => sourceFile(args, io),
    ".": async (args, io) => sourceFile(args, io),
    "command": async (args, io) => {
      // `command NAME args` — skip functions/builtins lookup preference; run direct.
      if (args[0] === "-v") { const n = args[1]; if (state.funcs.has(n) || BUILTINS[n]) { writeOut(io, n + "\n"); return 0; } return 1; }
      const env = { ...Object.fromEntries(state.vars), ...envExports() };
      return runtime.runExternal({ argv: args, env, cwd: session.cwd, stdin: io.stdin ? io.stdin.readAll() : null, redirects: [], out: io.out, err: io.err });
    },
    "type": async (args, io) => {
      const n = args[0];
      if (state.funcs.has(n)) { writeOut(io, n + " is a function\n"); return 0; }
      if (BUILTINS[n]) { writeOut(io, n + " is a shell builtin\n"); return 0; }
      writeOut(io, n + " not found\n"); return 1;
    },
    "uname": async (args, io) => {
      // Minimal uname so platform-detecting scripts run; reports the wasm host.
      const info = { s: "WorkerOS", m: "wasm32", r: "1", n: "worker", v: "wsh" };
      if (args.includes("-a")) { writeOut(io, `${info.s} ${info.n} ${info.r} ${info.v} ${info.m}\n`); return 0; }
      const out = [];
      for (const a of args) { if (a === "-s") out.push(info.s); else if (a === "-m") out.push(info.m); else if (a === "-r") out.push(info.r); else if (a === "-n") out.push(info.n); }
      writeOut(io, (out.length ? out.join(" ") : info.s) + "\n");
      return 0;
    },
  };

  async function sourceFile(args, io) {
    const bytes = await runtime.readFile(args[0], session.cwd);
    if (!bytes) { writeErr(io, "source: " + args[0] + ": No such file\n"); return 1; }
    const saved = state.params;
    if (args.length > 1) state.params = args.slice(1);
    try { return await runList(runtime.parse(dec.decode(bytes)), io); }
    finally { state.params = saved; }
  }

  function testBuiltin(args, io, bracket) {
    if (bracket) { if (args[args.length - 1] !== "]") { writeErr(io, "[: missing ]\n"); return 2; } args = args.slice(0, -1); }
    return evalTest(args) ? 0 : 1;
  }

  function evalTest(a) {
    if (a.length === 0) return false;
    if (a.length === 1) return a[0] !== "";
    // Handle leading ! (negation)
    if (a[0] === "!") return !evalTest(a.slice(1));
    if (a.length === 2) {
      const [op, x] = a;
      switch (op) {
        case "-z": return x === "";
        case "-n": return x !== "";
        case "-e": return !!runtime.statPathSync?.(x, session.cwd);
        case "-f": { const s = runtime.statPathSync?.(x, session.cwd); return !!(s && s.isFile); }
        case "-d": { const s = runtime.statPathSync?.(x, session.cwd); return !!(s && s.isDir); }
        case "-x": return !!runtime.statPathSync?.(x, session.cwd);
        case "-s": { const s = runtime.statPathSync?.(x, session.cwd); return !!s; }
        default: return x !== "";
      }
    }
    if (a.length === 3) {
      const [x, op, y] = a;
      switch (op) {
        case "=": case "==": return x === y;
        case "!=": return x !== y;
        case "-eq": return (+x) === (+y);
        case "-ne": return (+x) !== (+y);
        case "-lt": return (+x) < (+y);
        case "-le": return (+x) <= (+y);
        case "-gt": return (+x) > (+y);
        case "-ge": return (+x) >= (+y);
        case "<": return x < y;
        case ">": return x > y;
        default: return false;
      }
    }
    // Compound with -a / -o.
    const ai = a.indexOf("-a"), oi = a.indexOf("-o");
    if (oi >= 0) return evalTest(a.slice(0, oi)) || evalTest(a.slice(oi + 1));
    if (ai >= 0) return evalTest(a.slice(0, ai)) && evalTest(a.slice(ai + 1));
    return false;
  }

  // ---- public: run a whole script line/string ------------------------------
  let mainIo = null;
  async function run(src, io) {
    mainIo = io;
    let ast;
    try { ast = runtime.parse(src); }
    catch (e) { io.err(enc.encode(String(e.message || e) + "\n")); return 2; }
    try {
      const code = await runList(ast, io);
      await runTrap("EXIT", io);
      return code;
    } catch (e) {
      if (e instanceof ExitSignal) { await runTrap("EXIT", io); return e.code; }
      throw e;
    }
  }

  async function runTrap(sig, io) {
    const cmd = state.traps.get(sig);
    if (!cmd) return;
    state.traps.delete(sig); // avoid re-entry
    try { await runList(runtime.parse(cmd), io); } catch { /* ignore */ }
  }

  return { run, state, expandWord };
}

// ---- helpers ---------------------------------------------------------------

function concat(chunks) {
  let n = 0; for (const c of chunks) n += c.length;
  const b = new Uint8Array(n); let o = 0;
  for (const c of chunks) { b.set(c, o); o += c.length; }
  return b;
}

// Interpret C-style backslash escapes for `echo -e`: \n \t \r \e \a \b \f \v \\,
// \xHH, and \0NNN (octal). Returns { text, stop } where `stop` is set by \c
// (truncate output and drop the trailing newline). 92 is the backslash byte.
function echoEscapes(s) {
  const map = { n: 10, t: 9, r: 13, e: 27, E: 27, a: 7, b: 8, f: 12, v: 11 };
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 92 || i + 1 >= s.length) { out += s[i]; continue; }
    const c = s[++i];
    if (c === "\\") out += "\\";
    else if (c in map) out += String.fromCharCode(map[c]);
    else if (c === "c") return { text: out, stop: true };
    else if (c === "x") {
      let h = "";
      while (h.length < 2 && i + 1 < s.length && /[0-9a-fA-F]/.test(s[i + 1])) h += s[++i];
      out += h ? String.fromCharCode(parseInt(h, 16)) : "\\x";
    } else if (c >= "0" && c <= "7") {
      let o = c;
      while (o.length < 3 && i + 1 < s.length && s[i + 1] >= "0" && s[i + 1] <= "7") o += s[++i];
      out += String.fromCharCode(parseInt(o, 8) & 0xff);
    } else out += "\\" + c;
  }
  return { text: out, stop: false };
}

// Minimal printf: %s %d %% and \n \t \\ escapes; recycles the format over args.
function sprintf(fmt, args) {
  fmt = fmt.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
  let out = "";
  let ai = 0;
  const once = () => {
    return fmt.replace(/%[-0-9.]*[sdi%]/g, (m) => {
      if (m === "%%") return "%";
      const v = args[ai++] ?? "";
      if (m.endsWith("d") || m.endsWith("i")) return String(parseInt(v, 10) || 0);
      return String(v);
    });
  };
  // Repeat the format until args are consumed (bash behavior).
  do { out += once(); } while (ai < args.length && /%[-0-9.]*[sdi]/.test(fmt));
  return out;
}

// A tiny integer arithmetic evaluator for $(( )).
function arith(src, get, set) {
  let i = 0;
  const s = src;
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function primary() {
    skip();
    if (s[i] === "(") { i++; const v = expr(); skip(); if (s[i] === ")") i++; return v; }
    if (s[i] === "!") { i++; return primary() ? 0 : 1; }
    if (s[i] === "-") { i++; return -primary(); }
    if (s[i] === "+") { i++; return +primary(); }
    let m = s.slice(i).match(/^[0-9]+/);
    if (m) { i += m[0].length; return parseInt(m[0], 10); }
    m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (m) {
      i += m[0].length; skip();
      if (s[i] === "=" && s[i + 1] !== "=") { i++; const v = expr(); set(m[0], v); return v; }
      return get(m[0]);
    }
    return 0;
  }
  function mul() { let v = primary(); for (;;) { skip(); const op = s[i]; if (op === "*" || op === "/" || op === "%") { i++; const r = primary(); v = op === "*" ? v * r : op === "/" ? Math.trunc(v / r) : v % r; } else break; } return v; }
  function add() { let v = mul(); for (;;) { skip(); const op = s[i]; if (op === "+" || op === "-") { i++; const r = mul(); v = op === "+" ? v + r : v - r; } else break; } return v; }
  function cmp() { let v = add(); for (;;) { skip(); const two = s.slice(i, i + 2); if (["<=", ">=", "==", "!="].includes(two)) { i += 2; const r = add(); v = two === "<=" ? +(v <= r) : two === ">=" ? +(v >= r) : two === "==" ? +(v === r) : +(v !== r); } else if (s[i] === "<" || s[i] === ">") { const op = s[i]; i++; const r = add(); v = op === "<" ? +(v < r) : +(v > r); } else break; } return v; }
  function and() { let v = cmp(); for (;;) { skip(); if (s.slice(i, i + 2) === "&&") { i += 2; const r = cmp(); v = v && r ? 1 : 0; } else break; } return v; }
  function or() { let v = and(); for (;;) { skip(); if (s.slice(i, i + 2) === "||") { i += 2; const r = and(); v = v || r ? 1 : 0; } else break; } return v; }
  function expr() { return or(); }
  const result = expr();
  return result | 0;
}
