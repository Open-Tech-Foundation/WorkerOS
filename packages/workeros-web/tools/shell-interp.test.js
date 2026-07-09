// Unit tests for the wsh interpreter (packages/workeros-web/src/shell/).
//
// These run in plain Node (no browser/wasm): the interpreter is pure logic over
// a `runtime` object, so we drive it with an in-memory VFS + a handful of fake
// external programs and assert on captured output. Covers expansion, control
// flow, functions, command substitution, pipelines, redirects, and builtins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterpreter } from "../src/shell/interp.js";
import init, { WebKernel } from "../src/kernel-wasm/workeros_web_wasm.js";

// Parse with the real Rust parser (wasm) — the same one production uses — so the
// tests exercise the actual grammar, not a JS stand-in.
const wasmBytes = readFileSync(fileURLToPath(new URL("../src/kernel-wasm/workeros_web_wasm_bg.wasm", import.meta.url)));
await init({ module_or_path: wasmBytes });
const kernel = WebKernel.boot();
const parse = (src) => JSON.parse(kernel.shell_parse(src));

const enc = new TextEncoder();
const dec = new TextDecoder();
const concat = (cs) => { let n = 0; for (const c of cs) n += c.length; const b = new Uint8Array(n); let o = 0; for (const c of cs) { b.set(c, o); o += c.length; } return b; };

function makeRuntime(files = {}) {
  const vfs = new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)]));
  const dirs = new Set(["/", "/home", "/tmp"]);
  const externals = {
    cat: (argv, stdin) => (argv.length > 1 ? (vfs.get(argv[1]) || enc.encode("")) : (stdin || enc.encode(""))),
    grep: (argv, stdin) => { const pat = argv[argv.length - 1]; const lines = dec.decode(stdin || new Uint8Array()).split("\n"); return enc.encode(lines.filter((l) => l.includes(pat)).join("\n") + (lines.length ? "\n" : "")); },
    seq: (argv) => enc.encode(Array.from({ length: +argv[1] }, (_, i) => i + 1).join("\n") + "\n"),
    wc: (argv, stdin) => { const s = dec.decode(stdin || new Uint8Array()); return enc.encode(String(argv[1] === "-l" ? s.split("\n").filter(Boolean).length : s.length) + "\n"); },
    date: () => enc.encode("2026-07-09\n"),
    tr: (argv, stdin) => { const s = dec.decode(stdin || new Uint8Array()); if (argv[1] === "A-Z" && argv[2] === "a-z") return enc.encode(s.toLowerCase()); if (argv[1] === "a-z" && argv[2] === "A-Z") return enc.encode(s.toUpperCase()); return enc.encode(s); },
  };
  const readQueue = [];
  return {
    _vfs: vfs, _pushLine: (l) => readQueue.push(l),
    parse,
    async runExternal({ argv, stdin, redirects, out, err }) {
      let sout = out, serr = err, sin = stdin;
      const fileTargets = [];
      for (const r of redirects) {
        const fd = r.fd ?? (r.op.includes("<") ? 0 : 1);
        if (r.op.endsWith("&")) { if (r.target === "1" && fd === 2) serr = (b) => sout(b); else if (r.target === "2" && fd === 1) sout = (b) => serr(b); continue; }
        if (r.op === "<") { sin = vfs.get(r.target) || new Uint8Array(); continue; }
        if (r.op === ">" || r.op === ">>") { if (r.target === "/dev/null") { if (fd === 2) serr = () => {}; else sout = () => {}; continue; } const buf = []; const w = (b) => buf.push(b); if (fd === 2) serr = w; else sout = w; fileTargets.push({ path: r.target, append: r.op === ">>", buf }); }
      }
      const fn = externals[argv[0]];
      if (!fn) { serr(enc.encode(argv[0] + ": command not found\n")); return 127; }
      const res = fn(argv, sin);
      if (res && res.length) sout(res);
      for (const ft of fileTargets) { const prev = ft.append ? (vfs.get(ft.path) || new Uint8Array()) : new Uint8Array(); vfs.set(ft.path, concat([prev, concat(ft.buf)])); }
      return 0;
    },
    readFile: (p) => vfs.get(p) || null,
    writeFile: (p, cwd, bytes, append) => { const prev = append ? (vfs.get(p) || new Uint8Array()) : new Uint8Array(); vfs.set(p, concat([prev, bytes])); },
    statPathSync: (p) => (vfs.has(p) ? { isFile: true, isDir: false } : dirs.has(p) ? { isFile: false, isDir: true } : null),
    glob: (pattern) => { let src = "^"; for (const c of pattern) src += c === "*" ? "[^/]*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"); src += "$"; let re; try { re = new RegExp(src); } catch { return []; } return [...vfs.keys()].filter((k) => re.test(k)).sort(); },
    resolveDir: (cwd, target) => { const p = target.startsWith("/") ? target : (cwd === "/" ? "" : cwd) + "/" + target; if (dirs.has(p)) return p; throw new Error("no dir"); },
    readLine: async () => (readQueue.length ? readQueue.shift() : null),
  };
}

async function sh(script, { files = {}, env = {}, lines = [] } = {}) {
  const runtime = makeRuntime(files);
  for (const l of lines) runtime._pushLine(l);
  const session = { cwd: "/home", env: { HOME: "/home", PATH: "/bin", ...env } };
  const interp = createInterpreter({ runtime, session });
  const out = [], err = [];
  const code = await interp.run(script, { stdin: null, out: (b) => out.push(b), err: (b) => err.push(b) });
  return { code, out: dec.decode(concat(out)), err: dec.decode(concat(err)), vfs: runtime._vfs, cwd: session.cwd };
}

test("parameter expansion", async () => {
  assert.equal((await sh('x=hi; echo $x')).out, "hi\n");
  assert.equal((await sh('echo ${y:-fallback}')).out, "fallback\n");
  assert.equal((await sh('y=set; echo ${y:-fallback}')).out, "set\n");
  assert.equal((await sh('echo ${z:=assigned}; echo $z')).out, "assigned\nassigned\n");
  assert.equal((await sh('x=hello; echo ${#x}')).out, "5\n");
  assert.equal((await sh('f=archive.tar.gz; echo ${f%.gz}')).out, "archive.tar\n");
  assert.equal((await sh('p=/a/b/c; echo ${p##*/}')).out, "c\n");
  assert.equal((await sh('s=a-b-c; echo ${s//-/_}')).out, "a_b_c\n");
});

test("quoting and field splitting", async () => {
  assert.equal((await sh('x="a  b"; echo "$x"')).out, "a  b\n");
  assert.equal((await sh('x="a  b"; echo $x')).out, "a b\n");
});

test("command substitution and arithmetic", async () => {
  assert.equal((await sh('echo "today is $(date)"')).out, "today is 2026-07-09\n");
  assert.equal((await sh('v=$(seq 3); echo $v')).out, "1 2 3\n");
  assert.equal((await sh('echo $((2 + 3 * 4))')).out, "14\n");
  assert.equal((await sh('i=5; i=$((i + 1)); echo $i')).out, "6\n");
});

test("if / elif / else", async () => {
  assert.equal((await sh('if true; then echo yes; else echo no; fi')).out, "yes\n");
  assert.equal((await sh('if false; then echo yes; else echo no; fi')).out, "no\n");
  assert.equal((await sh('x=2; if [ $x -eq 1 ]; then echo one; elif [ $x -eq 2 ]; then echo two; else echo other; fi')).out, "two\n");
});

test("test / [ builtin", async () => {
  assert.equal((await sh('x=; if [ -z "$x" ]; then echo empty; fi')).out, "empty\n");
  assert.equal((await sh('a=foo; if [ "$a" = "foo" ]; then echo match; fi')).out, "match\n");
  assert.equal((await sh('if [ 3 -gt 2 ]; then echo bigger; fi')).out, "bigger\n");
  assert.equal((await sh('if [ -f /etc/x ]; then echo has; else echo no; fi', { files: { "/etc/x": "1" } })).out, "has\n");
});

test("for / while / until / break / continue", async () => {
  assert.equal((await sh('for i in a b c; do echo $i; done')).out, "a\nb\nc\n");
  assert.equal((await sh('for n in $(seq 3); do echo "n=$n"; done')).out, "n=1\nn=2\nn=3\n");
  assert.equal((await sh('i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done')).out, "0\n1\n2\n");
  assert.equal((await sh('i=0; until [ $i -ge 2 ]; do echo $i; i=$((i+1)); done')).out, "0\n1\n");
  assert.equal((await sh('for i in 1 2 3 4; do if [ $i -eq 3 ]; then break; fi; echo $i; done')).out, "1\n2\n");
  assert.equal((await sh('for i in 1 2 3; do if [ $i -eq 2 ]; then continue; fi; echo $i; done')).out, "1\n3\n");
});

test("case", async () => {
  assert.equal((await sh('x=linux; case $x in darwin) echo mac;; linux) echo tux;; *) echo other;; esac')).out, "tux\n");
  assert.equal((await sh('f=app.tar.gz; case $f in *.zip) echo zip;; *.tar.gz|*.tgz) echo tarball;; esac')).out, "tarball\n");
  assert.equal((await sh('x=zzz; case $x in a) echo a;; *) echo default;; esac')).out, "default\n");
});

test("functions and locals", async () => {
  assert.equal((await sh('greet() { echo "hi $1"; }; greet world')).out, "hi world\n");
  assert.equal((await sh('ok() { return 0; }; if ok; then echo good; fi')).out, "good\n");
  assert.equal((await sh('x=outer; f() { local x=inner; echo $x; }; f; echo $x')).out, "inner\nouter\n");
  assert.equal((await sh('add() { echo $(( $1 + $2 )); }; echo $(add 2 3)')).out, "5\n");
});

test("pipelines and redirects", async () => {
  assert.equal((await sh('seq 5 | grep 3')).out, "3\n");
  assert.equal((await sh('seq 4 | wc -l')).out, "4\n");
  assert.deepEqual(dec.decode((await sh('echo hello > /tmp/f')).vfs.get("/tmp/f")), "hello\n");
  assert.deepEqual(dec.decode((await sh('echo a > /tmp/f; echo b >> /tmp/f')).vfs.get("/tmp/f")), "a\nb\n");
  assert.equal((await sh('cat < /tmp/src', { files: { "/tmp/src": "content" } })).out, "content");
  assert.equal((await sh('echo hi > /dev/null; echo done')).out, "done\n");
  assert.equal((await sh('nope 2>&1')).out, "nope: command not found\n");
  assert.equal((await sh('seq 3 | while read n; do echo "got $n"; done')).out, "got 1\ngot 2\ngot 3\n");
});

test("builtins: cd / export / printf / read / set -e / trap", async () => {
  const cd = await sh('cd /tmp; pwd'); assert.equal(cd.out, "/tmp\n"); assert.equal(cd.cwd, "/tmp");
  assert.equal((await sh('export FOO=bar; echo $FOO')).out, "bar\n");
  assert.equal((await sh('printf "%s=%d\\n" key 42')).out, "key=42\n");
  assert.equal((await sh('read a; read b; echo "$a-$b"', { lines: ["one", "two"] })).out, "one-two\n");
  assert.equal((await sh('set -e; false; echo unreached')).code, 1);
  assert.equal((await sh('set -e; false; echo unreached')).out, "");
  assert.equal((await sh('set -e; false || true; echo reached')).out, "reached\n");
  assert.equal((await sh('trap "echo bye" EXIT; echo hi')).out, "hi\nbye\n");
  assert.equal((await sh('exit 7')).code, 7);
});

test("comments and globbing", async () => {
  assert.equal((await sh('echo a # ignored\n# whole line\necho b')).out, "a\nb\n");
  assert.equal((await sh('echo /data/*.txt', { files: { "/data/a.txt": "", "/data/b.txt": "", "/data/c.log": "" } })).out, "/data/a.txt /data/b.txt\n");
  assert.equal((await sh('echo /nope/*.xyz')).out, "/nope/*.xyz\n");
});

test("installer-shaped script (functions + case + $() + pipes + for)", async () => {
  const script = `#!/bin/bash
set -e
NAME="edgejs"
PREFIX="\${PREFIX:-/home/.local}"
detect_arch() {
  case "$1" in
    x86_64|amd64) echo amd64 ;;
    arm64|aarch64) echo arm64 ;;
    *) echo "$1" ;;
  esac
}
ARCH=$(detect_arch amd64)
TARGET="\${NAME}-linux-\${ARCH}"
echo "installing $TARGET into $PREFIX"
if [ -f /home/.local/bin/edgejs ]; then
  echo "already installed"
else
  for i in 1 2 3; do echo "attempt $i"; done
fi
echo "done"`;
  assert.equal((await sh(script)).out,
    "installing edgejs-linux-amd64 into /home/.local\nattempt 1\nattempt 2\nattempt 3\ndone\n");
});
