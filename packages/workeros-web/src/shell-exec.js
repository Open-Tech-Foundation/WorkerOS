// The `wsh` execution driver (host side).
//
// `wsh` is now a real (bash-subset) interpreter. Its grammar stays in Rust
// (ADR-012): `./shell/interp.js` parses via the kernel's `shell_parse` wasm
// binding and walks the resulting AST. This module is the host glue that builds
// the `runtime` the interpreter delegates to — parsing (Rust/wasm), spawning a
// program worker per external command, wiring stdio plans, capturing output for
// `$(…)` and pipelines, and VFS/glob/dir lookups.
//
// The evaluator is JS by necessity, not preference: running a command means
// spawning a program worker and awaiting it, and a wasm module can do neither —
// so the kernel (Rust) decides *what* happens (parse, resolve, spawn, VFS) and
// this driver performs the async plumbing between those kernel-owned steps.

import { createInterpreter } from "./shell/interp.js";

const enc = new TextEncoder();

let tmpSeq = 0;

/**
 * @param {object} deps
 * @param {*} deps.kernel        the wasm WebKernel
 * @param {Function} deps.startProcess  ({argv, env, cwd, plan, sink}) => {pid, exited}
 * @param {{cwd: string, env: Record<string,string>}} deps.session  mutable shell state
 * @param {() => Promise<string|null>} [deps.readLine]  read one interactive line
 *        from the controlling terminal (kernel TTY); null on EOF/^C.
 */
export function createShell({ kernel, startProcess, session, readLine }) {
  // Join a possibly-relative path against cwd (no symlinks; `.`/`..` collapsed).
  function absPath(cwd, p) {
    const base = p.startsWith("/") ? p : (cwd === "/" ? "" : cwd) + "/" + p;
    const segs = [];
    for (const part of base.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") segs.pop();
      else segs.push(part);
    }
    return "/" + segs.join("/");
  }

  // npm's PATH convention, kept in userland (the kernel just searches `$PATH`):
  // a bare command is looked up in `node_modules/.bin` — for this cwd and every
  // ancestor — before the system PATH. We prepend those (absolute) dirs to the
  // child's `PATH`; `npm install` writes the launcher files there. This is what
  // real npm does — edit the env, don't teach the OS about node_modules.
  function withNodeBinPath(cwd, env) {
    const chain = [];
    let dir = cwd || "/";
    for (;;) {
      chain.push((dir === "/" ? "" : dir) + "/node_modules/.bin");
      if (dir === "/") break;
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    }
    const base = (env && env.PATH) || "/bin:/sbin";
    return { ...env, PATH: chain.join(":") + ":" + base };
  }

  // Run one external program with a resolved stdio plan; returns its exit code.
  async function runExternal({ argv, env, cwd, stdin, redirects, out, err }) {
    const plan = { stdin: { kind: "inherit" }, stdout: { kind: "inherit" }, stderr: { kind: "inherit" } };
    let outSink = out || (() => {});
    let errSink = err || (() => {});
    const temps = [];

    // Provided stdin bytes (a pipe stage or `$()` feed) → a temp VFS file the
    // process reads. Simple and reliable; avoids a live pipe from JS.
    if (stdin && stdin.length) {
      const p = "/tmp/.wsh-in-" + tmpSeq++;
      try { kernel.fs_write(p, stdin); temps.push(p); plan.stdin = { kind: "file", path: p, mode: "read" }; } catch { /* /tmp missing */ }
    }

    for (const r of redirects) {
      const fd = r.fd ?? (r.op.includes("<") ? 0 : 1);
      const target = r.target;
      if (r.op.endsWith("&")) {
        // fd duplication: `2>&1` / `1>&2`.
        if (target === "1" && fd === 2) { plan.stderr = { ...plan.stdout }; errSink = outSink; }
        else if (target === "2" && fd === 1) { plan.stdout = { ...plan.stderr }; outSink = errSink; }
        continue;
      }
      if (r.op === "<") { plan.stdin = { kind: "file", path: absPath(cwd, target), mode: "read" }; continue; }
      if (r.op === ">" || r.op === ">>") {
        const mode = r.op === ">>" ? "append" : "write";
        if (target === "/dev/null") { if (fd === 2) errSink = () => {}; else outSink = () => {}; continue; }
        const t = { kind: "file", path: absPath(cwd, target), mode };
        if (fd === 2) plan.stderr = t; else plan.stdout = t;
        continue;
      }
    }

    const cleanup = () => { for (const p of temps) { try { kernel.sys_unlink?.(0, p); } catch {} } };

    let handle;
    try {
      handle = startProcess({ argv, env: withNodeBinPath(cwd, env), cwd, plan, sink: { stdout: (b) => outSink(b), stderr: (b) => errSink(b) } });
    } catch (e) {
      errSink(enc.encode((argv[0] || "wsh") + ": " + (e.message || e) + "\n"));
      cleanup();
      return 127;
    }
    const code = await handle.exited;
    cleanup();
    return code | 0;
  }

  const runtime = {
    // Parse in Rust (fast wasm), walk the AST in JS. Grammar stays kernel-owned
    // (ADR-012); the kernel serializes the AST to JSON and we hydrate it here.
    parse: (src) => JSON.parse(kernel.shell_parse(src)),
    runExternal,
    readFile: (path, cwd) => {
      try { return kernel.fs_read(absPath(cwd, path)); } catch { return null; }
    },
    writeFile: (path, cwd, bytes, append) => {
      const abs = absPath(cwd, path);
      let data = bytes;
      if (append) {
        try { const prev = kernel.fs_read(abs); const m = new Uint8Array(prev.length + bytes.length); m.set(prev, 0); m.set(bytes, prev.length); data = m; } catch { /* new file */ }
      }
      kernel.fs_write(abs, data);
    },
    statPathSync: (path, cwd) => {
      try { kernel.resolve_dir(cwd, path); return { isFile: false, isDir: true }; } catch { /* not a dir */ }
      try { kernel.fs_read(absPath(cwd, path)); return { isFile: true, isDir: false }; } catch { return null; }
    },
    // Reuse the Rust globber (ADR-012) via a throwaway plan; drop the command word.
    glob: (pattern, cwd) => {
      try {
        const plan = kernel.shell_plan("wsh-glob " + pattern, cwd);
        const cmd = plan.statements[0].steps[0].commands[0];
        return cmd.argv.slice(1);
      } catch { return []; }
    },
    resolveDir: (cwd, target) => kernel.resolve_dir(cwd, target),
    // Interactive `read` from the controlling terminal, backed by the kernel TTY
    // line discipline. Falls back to EOF when no terminal is attached (e.g. the
    // programmatic `os.exec` path, which has no interactive input).
    readLine: readLine || (async () => null),
  };

  const interp = createInterpreter({ runtime, session });

  /** Run a full command line / script; stream output to `sink`; resolve exit code. */
  async function exec(line, sink) {
    const io = { stdin: null, out: (b) => sink.stdout(b), err: (b) => sink.stderr(b) };
    try {
      return await interp.run(line, io);
    } catch (e) {
      sink.stderr(enc.encode("wsh: " + (e && e.message ? e.message : e) + "\n"));
      return 1;
    }
  }

  // Source the login profiles once at startup, so their `export`s (notably PATH)
  // take effect for the whole session. `/etc/profile` is OS-provided defaults
  // (it puts npm's global `.bin` on PATH); `~/.profile` is the user's overrides.
  // Missing files are skipped. This is the shell's own login behavior — the
  // kernel and its PATH resolver stay oblivious to any of it (INV-1).
  async function sourceProfile(sink) {
    const io = sink || { stdout: () => {}, stderr: () => {} };
    const home = (session.env && session.env.HOME) || "/";
    const files = ["/etc/profile", (home === "/" ? "" : home) + "/.profile"];
    for (const f of files) {
      try { if (!kernel.fs_read(f)) continue; } catch { continue; } // missing → skip
      await exec("source " + f, io);
    }
  }

  return { exec, sourceProfile };
}
