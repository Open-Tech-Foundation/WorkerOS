// `sh` / `bash` — run a wsh script. A guest program (INV-1) installed at /bin/sh
// and /bin/bash. It reads a script from one of the usual sources and runs it
// through the shell driver via the `sys.exec` syscall (the same system(3)-style
// path npm uses for `run` scripts), so the classic installer idiom works:
//
//   curl -fsSL https://example.com/install.sh | bash
//   sh ./setup.sh
//   bash -c 'for i in 1 2 3; do echo $i; done'
//
// wsh is a bash-*subset* (see workeros-web/src/shell): expansion, $(...),
// if/for/while/case, functions, test/[, pipes, redirects. Constructs outside that
// subset — and anything a script tries to *do* that the sandbox can't (run a
// native binary, open a socket) — still fail; this only supplies the entrypoint.
//
// Authored as a plain top-level-await script so it runs through the program
// worker's ESM path.

import { ArgError, tokenizeArgv } from "/lib/workeros-cli/args.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const err = (s) => sys.write(2, enc.encode(s));

const args = sys.argv.slice(1);

// Read all of stdin (a pipe from `curl … | bash`, or an interactive heredoc).
async function readStdin() {
  const chunks = [];
  for (;;) {
    const b = await sys.read(0, 1 << 16);
    if (!b || b.length === 0) break;
    chunks.push(b);
  }
  let n = 0;
  for (const c of chunks) n += c.length;
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return dec.decode(buf);
}

async function readFile(path) {
  const fd = await sys.open(path, {});
  const chunks = [];
  try {
    for (;;) {
      const b = await sys.read(fd, 1 << 16);
      if (!b || b.length === 0) break;
      chunks.push(b);
    }
  } finally {
    await sys.close(fd);
  }
  let n = 0;
  for (const c of chunks) n += c.length;
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return dec.decode(buf);
}

// ---- resolve the script ----------------------------------------------------
let script = null;
let file = null;
const rest = [];

try {
  for (const tok of tokenizeArgv(args, {
    shortAlias: { c: "command", s: "stdin", e: "errexit", x: "xtrace", u: "nounset" },
    shortValue: new Set(["c"]),
    stopAtFirstOperand: true,
  })) {
    if (tok.kind === "operand") {
      if (tok.value === "-" && file === null) continue;
      if (file === null) file = tok.value;
      else rest.push(tok.value);
      continue;
    }
    if (tok.kind !== "option") continue;
    if (tok.name === "command") script = tok.value ?? "";
    else if (tok.name === "stdin" || tok.name === "errexit" || tok.name === "xtrace" || tok.name === "nounset") { /* honored inside */ }
  }
} catch (e) {
  if (e instanceof ArgError) {
    err("sh: " + e.message + "\n");
    sys.exit(1);
  }
  throw e;
}

try {
  if (script === null) {
    if (file !== null) {
      script = await readFile(file);
    } else {
      script = await readStdin();
    }
  }
} catch (e) {
  err("sh: " + (e && e.message ? e.message : e) + "\n");
  sys.exit(1);
}

if (!script || !script.trim()) {
  sys.exit(0);
}

// Pass positional parameters ($1, $2, …) when a script file has trailing args.
if (file !== null && rest.length) {
  const quoted = rest.map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(" ");
  script = "set -- " + quoted + "\n" + script;
}

// Run it through the shell driver; the exit code is the script's.
const code = await sys.exec(script);
sys.exit(code | 0);
