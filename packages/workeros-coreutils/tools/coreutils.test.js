// Unit tests for the coreutils. Each coreutil is a self-contained program string
// run against the `sys` ABI; here we evaluate the body with a mock `sys` (an
// in-memory VFS + a stdin buffer) and assert on captured stdout/stderr/exit — no
// browser or wasm needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { coreutils } from "../src/index.js";
import { collectSimpleFlags, hasFlag as hasParsedFlag } from "../../workeros-programs/src/cli/args.js";

const enc = new TextEncoder(), dec = new TextDecoder();

async function run(name, { argv = [], stdin = "", files = {} } = {}) {
  const body = coreutils["/sbin/" + name].replace(/^import .*?\n/, "");
  const outB = [], errB = [];
  const vfs = new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)]));
  const fds = new Map();
  let nextFd = 3;
  fds.set(0, { data: enc.encode(stdin), pos: 0 });
  const sys = {
    argv: [name, ...argv], env: { HOME: "/home" }, cwd: "/",
    write: (fd, bytes) => { (fd === 2 ? errB : outB).push(bytes); return bytes.length; },
    read: async (fd, max) => {
      const f = fds.get(fd); if (!f || f.pos >= f.data.length) return new Uint8Array(0);
      const slice = f.data.subarray(f.pos, f.pos + max); f.pos += slice.length; return slice;
    },
    open: async (path) => { if (!vfs.has(path)) throw new Error("ENOENT"); const fd = nextFd++; fds.set(fd, { data: vfs.get(path), pos: 0 }); return fd; },
    close: async (fd) => { fds.delete(fd); },
    stat: async (path) => { if (vfs.has(path)) return { kind: "file", size: vfs.get(path).length }; throw new Error("ENOENT"); },
    readdir: async () => [],
    exit: (code) => { const e = new Error("exit"); e.__exit = code | 0; throw e; },
  };
  let code = 0;
  const fn = new Function(
    "sys",
    "collectSimpleFlags",
    "hasParsedFlag",
    "return (async () => {\n" + body + "\n})();",
  );
  try { await fn(sys, collectSimpleFlags, hasParsedFlag); } catch (e) { if (e && e.__exit !== undefined) code = e.__exit; else throw e; }
  return { code, out: outB.map((b) => dec.decode(b)).join(""), err: errB.map((b) => dec.decode(b)).join("") };
}

test("seq", async () => {
  assert.equal((await run("seq", { argv: ["3"] })).out, "1\n2\n3\n");
  assert.equal((await run("seq", { argv: ["2", "5"] })).out, "2\n3\n4\n5\n");
  assert.equal((await run("seq", { argv: ["1", "2", "5"] })).out, "1\n3\n5\n");
  assert.equal((await run("seq", { argv: ["-2", "2"] })).out, "-2\n-1\n0\n1\n2\n");
});

test("unsupported options fail clearly", async () => {
  for (const [name, argv, option] of [
    ["cat", ["-z"], "-z"],
    ["ls", ["-az"], "-z"],
    ["pwd", ["--physical"], "--physical"],
    ["cp", ["-r", "from", "to"], "-r"],
    ["head", ["-q"], "-q"],
    ["cut", ["-s", "-f1"], "-s"],
    ["seq", ["-x"], "-x"],
  ]) {
    const result = await run(name, { argv });
    assert.equal(result.code, 2, `${name} should reject ${option}`);
    assert.equal(result.out, "");
    assert.equal(result.err, `${name}: unrecognized option '${option}'\n`);
  }
});

test("-- preserves option-looking file operands", async () => {
  const files = { "-notes": "kept\n" };
  assert.deepEqual(await run("cat", { argv: ["--", "-notes"], files }), {
    code: 0,
    out: "kept\n",
    err: "",
  });
  assert.equal((await run("head", { argv: ["-n1", "--", "-notes"], files })).out, "kept\n");
});

test("head / tail", async () => {
  assert.equal((await run("head", { argv: ["-n", "2"], stdin: "x\ny\nz\n" })).out, "x\ny\n");
  assert.equal((await run("tail", { argv: ["-n", "2"], stdin: "x\ny\nz\n" })).out, "y\nz\n");
  assert.equal((await run("head", { argv: ["-n", "1", "/d.txt"], files: { "/d.txt": "L1\nL2\n" } })).out, "L1\n");
});

test("wc", async () => {
  assert.equal((await run("wc", { argv: ["-l"], stdin: "a\nb\nc\n" })).out, "3\n");
  assert.equal((await run("wc", { argv: ["-w"], stdin: "a b c d\n" })).out, "4\n");
  assert.equal((await run("wc", { stdin: "one two\nthree\n" })).out, "2 3 14\n");
});

test("sort", async () => {
  assert.equal((await run("sort", { stdin: "banana\napple\ncherry\n" })).out, "apple\nbanana\ncherry\n");
  assert.equal((await run("sort", { argv: ["-rn"], stdin: "2\n10\n1\n" })).out, "10\n2\n1\n");
  assert.equal((await run("sort", { argv: ["-u"], stdin: "b\na\nb\na\n" })).out, "a\nb\n");
});

test("uniq", async () => {
  assert.equal((await run("uniq", { stdin: "a\na\nb\nb\nb\nc\n" })).out, "a\nb\nc\n");
  assert.equal((await run("uniq", { argv: ["-c"], stdin: "a\na\nb\n" })).out, "      2 a\n      1 b\n");
});

test("cut", async () => {
  assert.equal((await run("cut", { argv: ["-d", ":", "-f", "1"], stdin: "a:b:c\nx:y:z\n" })).out, "a\nx\n");
  assert.equal((await run("cut", { argv: ["-d", ",", "-f", "1,3"], stdin: "1,2,3,4\n" })).out, "1,3\n");
});

test("tr", async () => {
  assert.equal((await run("tr", { argv: ["a-z", "A-Z"], stdin: "hello\n" })).out, "HELLO\n");
  assert.equal((await run("tr", { argv: ["-d", "aeiou"], stdin: "hello world\n" })).out, "hll wrld\n");
});

test("ls", async () => {
  const vfs = { "/dir/.hidden": "", "/dir/a.txt": "123", "/dir/b.txt": "1234567" };
  const st = {
    argv: ["-a", "/dir"], files: vfs,
    sysOverrides: {
      stat: async (p) => ({ kind: Object.keys(vfs).some(k => k.startsWith(p + "/")) ? "dir" : "file", size: vfs[p] ? vfs[p].length : 0 }),
      readdir: async (p) => Object.keys(vfs).filter(k => k.startsWith(p + "/") && k.slice(p.length + 1).indexOf("/") === -1).map(k => ({ name: k.slice(p.length + 1) }))
    }
  };
  
  // Custom run for ls because it needs readdir mock
  async function runLs(args) {
    const body = coreutils["/sbin/ls"].replace(/^import .*?\n/, "");
    let out = "";
    const sys = {
      argv: ["ls", ...args], cwd: "/",
      write: (fd, bytes) => { if(fd===1) out += dec.decode(bytes); },
      stat: st.sysOverrides.stat,
      readdir: st.sysOverrides.readdir,
      exit: (code) => { const e = new Error(); e.code = code; throw e; }
    };
    try {
      await new Function(
        "sys",
        "collectSimpleFlags",
        "hasParsedFlag",
        "return (async () => { " + body + "})();",
      )(sys, collectSimpleFlags, hasParsedFlag);
    } catch(e) {}
    return out;
  }
  
  assert.equal(await runLs(["/dir"]), "a.txt\nb.txt\n");
  assert.equal(await runLs(["-a", "/dir"]), ".hidden\na.txt\nb.txt\n");
  assert.equal(await runLs(["-r", "/dir"]), "b.txt\na.txt\n");
  assert.equal(await runLs(["-l", "/dir"]), "-rw-r--r--        3 a.txt\n-rw-r--r--        7 b.txt\n");
});

// grep is a Rust `wasm32-wasip1` binary (crates/wsh-grep), not a JS coreutil —
// tested in that crate and in the browser pipeline suite.
