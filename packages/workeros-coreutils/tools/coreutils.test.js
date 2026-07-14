// Unit tests for the coreutils. Each coreutil is a self-contained program string
// run against the `sys` ABI; here we evaluate the body with a mock `sys` (an
// in-memory VFS + a stdin buffer) and assert on captured stdout/stderr/exit — no
// browser or wasm needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { coreutils } from "../src/index.js";
import { collectSimpleFlags, hasFlag as hasParsedFlag } from "../../workeros-programs/src/cli/args.js";

const enc = new TextEncoder(), dec = new TextDecoder();

async function run(name, {
  argv = [], stdin = "", files = {}, dirs = [], readErrors = [], writeErrors = [], mkdirErrors = [], inspectFds = false,
} = {}) {
  const body = coreutils["/sbin/" + name].replace(/^import .*?\n/, "");
  const outB = [], errB = [];
  const vfs = new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)]));
  const dirSet = new Set(dirs);
  const fds = new Map();
  let nextFd = 3;
  fds.set(0, { data: enc.encode(stdin), pos: 0 });
  const sys = {
    argv: [name, ...argv], env: { HOME: "/home" }, cwd: "/",
    write: (fd, bytes) => {
      if (fd === 1 || fd === 2) {
        (fd === 2 ? errB : outB).push(bytes);
        return bytes.length;
      }
      const f = fds.get(fd);
      if (!f || !f.path) throw new Error("EBADF");
      if (writeErrors.includes(f.path)) throw new Error("EIO");
      const data = new Uint8Array(Math.max(f.data.length, f.pos + bytes.length));
      data.set(f.data); data.set(bytes, f.pos); f.pos += bytes.length; f.data = data;
      vfs.set(f.path, data);
      return bytes.length;
    },
    read: async (fd, max) => {
      const f = fds.get(fd);
      if (f?.path && readErrors.includes(f.path)) throw new Error("EIO");
      if (!f || f.pos >= f.data.length) return new Uint8Array(0);
      const slice = f.data.subarray(f.pos, f.pos + max); f.pos += slice.length; return slice;
    },
    open: async (path, opts = {}) => {
      if (dirSet.has(path)) throw new Error("EISDIR");
      if (!vfs.has(path) && !opts.create) throw new Error("ENOENT");
      if (!vfs.has(path) || opts.truncate) vfs.set(path, new Uint8Array(0));
      const fd = nextFd++; fds.set(fd, { data: vfs.get(path), pos: 0, path }); return fd;
    },
    close: async (fd) => { fds.delete(fd); },
    stat: async (path) => {
      if (dirSet.has(path)) return { kind: "dir", size: 0 };
      if (vfs.has(path)) return { kind: "file", size: vfs.get(path).length };
      throw new Error("ENOENT");
    },
    readdir: async () => [],
    mkdir: async (path) => {
      if (mkdirErrors.includes(path)) throw new Error("EPERM");
      if (dirSet.has(path) || vfs.has(path)) throw new Error("EEXIST");
      dirSet.add(path);
    },
    rename: async (from, to) => {
      if (!vfs.has(from)) throw new Error("ENOENT");
      vfs.set(to, vfs.get(from)); vfs.delete(from);
    },
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
  const result = {
    code,
    out: outB.map((b) => dec.decode(b)).join(""),
    err: errB.map((b) => dec.decode(b)).join(""),
    files: Object.fromEntries([...vfs].map(([path, data]) => [path, dec.decode(data)])),
  };
  if (inspectFds) result.openFds = [...fds.keys()].filter((fd) => fd > 2);
  return result;
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

test("missing, extra, and malformed operands fail clearly", async () => {
  for (const [name, argv, message] of [
    ["pwd", ["extra"], "extra operand 'extra'"],
    ["env", ["NAME=value"], "unsupported operand 'NAME=value'"],
    ["mkdir", [], "missing operand"],
    ["rm", [], "missing operand"],
    ["cp", ["a", "b", "c"], "target 'c' is not a directory"],
    ["mv", ["a", "b", "c"], "target 'c' is not a directory"],
    ["seq", [], "missing operand"],
    ["seq", ["one"], "invalid number 'one'"],
    ["seq", ["1", "2", "3", "4"], "extra operand '4'"],
    ["head", ["-n"], "option requires an argument -- 'n'"],
    ["tail", ["-n", "many"], "invalid number of lines: 'many'"],
    ["cut", ["-d"], "option requires an argument -- 'd'"],
    ["cut", ["-d::", "-f1"], "the delimiter must be a single character"],
    ["cut", ["-f", "0"], "invalid field list '0'"],
    ["cut", ["-f", "3-1"], "invalid field list '3-1'"],
    ["tr", [], "missing operand"],
    ["tr", ["a", "b", "c"], "extra operand 'c'"],
    ["tr", ["-d", "a", "b"], "extra operand 'b'"],
    ["uniq", ["in", "out", "extra"], "extra operand 'extra'"],
  ]) {
    const result = await run(name, { argv });
    assert.equal(result.code, 1, `${name} should reject ${JSON.stringify(argv)}`);
    assert.equal(result.out, "");
    assert.equal(result.err, `${name}: ${message}\n`);
  }

  assert.equal((await run("rm", { argv: ["-f"] })).code, 0, "rm -f accepts no operands");
});

test("-- preserves option-looking file operands", async () => {
  const files = { "-notes": "kept\n" };
  assert.deepEqual(await run("cat", { argv: ["--", "-notes"], files }), {
    code: 0,
    out: "kept\n",
    err: "",
    files,
  });
  assert.equal((await run("head", { argv: ["-n1", "--", "-notes"], files })).out, "kept\n");
});

test("file descriptors close after injected I/O failures", async () => {
  const cat = await run("cat", {
    argv: ["/input"], files: { "/input": "data" }, readErrors: ["/input"], inspectFds: true,
  });
  assert.equal(cat.code, 1);
  assert.deepEqual(cat.openFds, []);

  const head = await run("head", {
    argv: ["/input"], files: { "/input": "data" }, readErrors: ["/input"], inspectFds: true,
  });
  assert.equal(head.code, 1);
  assert.deepEqual(head.openFds, []);

  for (const failure of [
    { readErrors: ["/source"] },
    { writeErrors: ["/dest"] },
  ]) {
    const cp = await run("cp", {
      argv: ["/source", "/dest"], files: { "/source": "data" }, inspectFds: true, ...failure,
    });
    assert.equal(cp.code, 1);
    assert.deepEqual(cp.openFds, []);
  }

  const uniq = await run("uniq", {
    argv: ["/input", "/output"],
    files: { "/input": "a\na\n" },
    writeErrors: ["/output"],
    inspectFds: true,
  });
  assert.equal(uniq.code, 1);
  assert.deepEqual(uniq.openFds, []);
});

test("filesystem diagnostics preserve the underlying error", async () => {
  assert.equal((await run("cat", { argv: ["/missing"] })).err, "cat: /missing: ENOENT\n");
  assert.equal(
    (await run("cat", {
      argv: ["/input"], files: { "/input": "data" }, readErrors: ["/input"],
    })).err,
    "cat: /input: EIO\n",
  );

  const ls = await run("ls", { argv: ["/missing"] });
  assert.equal(ls.code, 1);
  assert.equal(ls.err, "ls: /missing: ENOENT\n");

  for (const argv of [["/blocked"], ["-p", "/blocked"]]) {
    const mkdir = await run("mkdir", { argv, mkdirErrors: ["/blocked"] });
    assert.equal(mkdir.code, 1);
    assert.equal(mkdir.err, "mkdir: cannot create directory '/blocked': EPERM\n");
  }

  assert.equal((await run("mkdir", { argv: ["-p", "/existing"], dirs: ["/existing"] })).code, 0);
});

test("cp and mv accept multiple sources for a directory", async () => {
  const cp = await run("cp", {
    argv: ["/a", "/b", "/dest"],
    files: { "/a": "A", "/b": "B" },
    dirs: ["/dest"],
  });
  assert.equal(cp.code, 0);
  assert.equal(cp.files["/dest/a"], "A");
  assert.equal(cp.files["/dest/b"], "B");
  assert.equal(cp.files["/a"], "A");

  const mv = await run("mv", {
    argv: ["/a", "/b", "/dest"],
    files: { "/a": "A", "/b": "B" },
    dirs: ["/dest"],
  });
  assert.equal(mv.code, 0);
  assert.equal(mv.files["/dest/a"], "A");
  assert.equal(mv.files["/dest/b"], "B");
  assert.equal(mv.files["/a"], undefined);
  assert.equal(mv.files["/b"], undefined);
});

test("multi-source cp continues after one source fails", async () => {
  const result = await run("cp", {
    argv: ["/missing", "/good", "/dest"],
    files: { "/good": "kept" },
    dirs: ["/dest"],
  });
  assert.equal(result.code, 1);
  assert.equal(result.err, "cp: /missing: ENOENT\n");
  assert.equal(result.files["/dest/good"], "kept");
});

test("cp refuses an identical source and destination", async () => {
  const result = await run("cp", { argv: ["/same", "/same"], files: { "/same": "preserved" } });
  assert.equal(result.code, 1);
  assert.equal(result.err, "cp: /same: source and destination are the same file\n");
  assert.equal(result.files["/same"], "preserved");
});

test("head / tail", async () => {
  assert.equal((await run("head", { argv: ["-n", "2"], stdin: "x\ny\nz\n" })).out, "x\ny\n");
  assert.equal((await run("tail", { argv: ["-n", "2"], stdin: "x\ny\nz\n" })).out, "y\nz\n");
  assert.equal((await run("head", { argv: ["-n", "1", "/d.txt"], files: { "/d.txt": "L1\nL2\n" } })).out, "L1\n");
});

test("head / tail process multiple files independently", async () => {
  const files = { "/a": "a1\na2\n", "/b": "b1\nb2\n" };
  const head = await run("head", { argv: ["-n1", "/a", "/b"], files });
  assert.equal(head.out, "==> /a <==\na1\n\n==> /b <==\nb1\n");
  assert.equal(head.code, 0);

  const tail = await run("tail", { argv: ["-n1", "/a", "/b"], files });
  assert.equal(tail.out, "==> /a <==\na2\n\n==> /b <==\nb2\n");
  assert.equal(tail.code, 0);

  const partial = await run("head", { argv: ["-n1", "/missing", "/a"], files });
  assert.equal(partial.code, 1);
  assert.equal(partial.err, "head: cannot open '/missing': ENOENT\n");
  assert.equal(partial.out, "==> /a <==\na1\n");
});

test("wc", async () => {
  assert.equal((await run("wc", { argv: ["-l"], stdin: "a\nb\nc\n" })).out, "3\n");
  assert.equal((await run("wc", { argv: ["-w"], stdin: "a b c d\n" })).out, "4\n");
  assert.equal((await run("wc", { stdin: "one two\nthree\n" })).out, "2 3 14\n");
});

test("wc reports each file and a total", async () => {
  const files = { "/a": "one two\n", "/b": "x\n" };
  assert.equal((await run("wc", { argv: ["-lw", "/a"], files })).out, "1 2 /a\n");
  assert.equal(
    (await run("wc", { argv: ["-lw", "/a", "/b"], files })).out,
    "1 2 /a\n1 1 /b\n2 3 total\n",
  );
});

test("wc -c counts UTF-8 bytes instead of JavaScript string units", async () => {
  assert.equal((await run("wc", { stdin: "é 🙂\n" })).out, "1 2 8\n");

  const files = { "/unicode": "é🙂\n", "/ascii": "x\n" };
  assert.equal((await run("wc", { argv: ["-c", "/unicode"], files })).out, "7 /unicode\n");
  assert.equal(
    (await run("wc", { argv: ["-c", "/unicode", "/ascii"], files })).out,
    "7 /unicode\n2 /ascii\n9 total\n",
  );
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

test("uniq accepts one input and one output file", async () => {
  const result = await run("uniq", {
    argv: ["/input", "/output"],
    files: { "/input": "a\na\nb\nb\n" },
  });
  assert.equal(result.code, 0);
  assert.equal(result.out, "");
  assert.equal(result.files["/output"], "a\nb\n");
});

test("cut", async () => {
  assert.equal((await run("cut", { argv: ["-d", ":", "-f", "1"], stdin: "a:b:c\nx:y:z\n" })).out, "a\nx\n");
  assert.equal((await run("cut", { argv: ["-d", ",", "-f", "1,3"], stdin: "1,2,3,4\n" })).out, "1,3\n");
});

test("cut preserves source field order and non-delimited lines", async () => {
  const input = "plain text\na:b:c:d\n";
  assert.equal((await run("cut", { argv: ["-d:", "-f3,1"], stdin: input })).out, "plain text\na:c\n");
  assert.equal((await run("cut", { argv: ["-d:", "-f1-3,2-4"], stdin: "a:b:c:d\n" })).out, "a:b:c:d\n");
});

test("tr", async () => {
  assert.equal((await run("tr", { argv: ["a-z", "A-Z"], stdin: "hello\n" })).out, "HELLO\n");
  assert.equal((await run("tr", { argv: ["-d", "aeiou"], stdin: "hello world\n" })).out, "hll wrld\n");
});

test("ls", async () => {
  const vfs = { "/dir/.hidden": "", "/dir/a.txt": "123", "/dir/b.txt": "1234567" };
  const metadata = {
    "/dir/a.txt": { mtime: Date.UTC(2024, 0, 2, 3, 4), nlink: 2 },
    "/dir/b.txt": { kind: "symlink" },
  };
  const st = {
    argv: ["-a", "/dir"], files: vfs,
    sysOverrides: {
      stat: async (p) => ({
        kind: Object.keys(vfs).some(k => k.startsWith(p + "/")) ? "dir" : "file",
        size: vfs[p] ? vfs[p].length : 0,
        mtime: 0,
        nlink: 1,
        ...(metadata[p] || {}),
      }),
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
  assert.equal(
    await runLs(["-l", "/dir"]),
    "-rw-r--r--  2        3 2024-01-02 03:04 a.txt\n" +
      "lrwxrwxrwx  1        7 1970-01-01 00:00 b.txt\n",
  );
});

// grep is a Rust `wasm32-wasip1` binary (crates/wsh-grep), not a JS coreutil —
// tested in that crate and in the browser pipeline suite.
