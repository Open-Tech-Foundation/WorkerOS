import test from "node:test";
import assert from "node:assert/strict";
import { createChildProcess } from "../src/node/child-process.js";

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s);

// A fake `sys` whose exec* calls are answered by a routing function `respond(line,
// input)` -> { code, stdout, stderr }. Records every command line + stdin seen.
function fakeSys(respond) {
  const calls = [];
  const run = (line, input) => {
    calls.push({ line, input: input ? new TextDecoder().decode(input) : null });
    const r = respond(line, input) || {};
    return { code: r.code || 0, stdout: bytes(r.stdout || ""), stderr: bytes(r.stderr || "") };
  };
  return {
    calls,
    execCapture: async (line, input) => run(line, input),
    execCaptureSync: (line, input) => run(line, input),
  };
}

test("execSync returns stdout as a Buffer by default, string with an encoding", () => {
  const sys = fakeSys((line) => (line === "echo hi" ? { stdout: "hi\n" } : {}));
  const cp = createChildProcess(sys);
  const buf = cp.execSync("echo hi");
  assert.ok(buf instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(buf), "hi\n");
  assert.equal(cp.execSync("echo hi", { encoding: "utf8" }), "hi\n");
});

test("execSync throws on a non-zero exit, carrying status/stdout/stderr", () => {
  const sys = fakeSys(() => ({ code: 2, stdout: "out", stderr: "boom" }));
  const cp = createChildProcess(sys);
  assert.throws(
    () => cp.execSync("false"),
    (e) => {
      assert.equal(e.status, 2);
      assert.equal(e.stderr.toString(), "boom");
      assert.equal(e.stdout.toString(), "out");
      return true;
    },
  );
});

test("execFileSync quotes args literally (no shell interpretation)", () => {
  const sys = fakeSys(() => ({ stdout: "" }));
  const cp = createChildProcess(sys);
  cp.execFileSync("echo", ["a b", "$HOME", "it's"]);
  assert.equal(sys.calls[0].line, "'echo' 'a b' '$HOME' 'it'\\''s'");
});

test("cwd and env are wrapped in an isolating subshell", () => {
  const sys = fakeSys(() => ({}));
  const cp = createChildProcess(sys);
  cp.execSync("git status", { cwd: "/repo", env: { TOKEN: "x y" } });
  assert.equal(sys.calls[0].line, "( cd '/repo'; export TOKEN='x y'; git status )");
});

test("spawnSync returns the object shape with status/stdout/stderr", () => {
  const sys = fakeSys(() => ({ code: 1, stdout: "o", stderr: "e" }));
  const cp = createChildProcess(sys);
  const r = cp.spawnSync("node", ["-v"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.toString(), "o");
  assert.equal(r.stderr.toString(), "e");
  assert.deepEqual(r.output.map((x) => (x ? x.toString() : x)), [null, "o", "e"]);
  assert.equal(sys.calls[0].line, "'node' '-v'");
});

test("exec (async) delivers decoded stdout/stderr to its callback", async () => {
  const sys = fakeSys(() => ({ stdout: "hello\n", stderr: "" }));
  const cp = createChildProcess(sys);
  const { out, err } = await new Promise((resolve) => {
    cp.exec("echo hello", (e, out, err) => resolve({ e, out, err }));
  });
  assert.equal(out, "hello\n");
  assert.equal(err, "");
});

test("exec (async) reports a non-zero exit as an Error with .code", async () => {
  const sys = fakeSys(() => ({ code: 3, stderr: "nope" }));
  const cp = createChildProcess(sys);
  const e = await new Promise((resolve) => cp.exec("bad", (e) => resolve(e)));
  assert.ok(e instanceof Error);
  assert.equal(e.code, 3);
  assert.match(e.message, /nope/);
});

test("spawn emits buffered stdout data then exit/close", async () => {
  const sys = fakeSys(() => ({ code: 0, stdout: "line1\nline2\n" }));
  const cp = createChildProcess(sys);
  const child = cp.spawn("cat", ["file"]);
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d.toString()));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(chunks.join(""), "line1\nline2\n");
  assert.equal(child.exitCode, 0);
});

test("spawn feeds written stdin to the child, launching on end()", async () => {
  let seenInput = null;
  const sys = fakeSys((line, input) => {
    seenInput = input ? new TextDecoder().decode(input) : null;
    return { stdout: "" };
  });
  const cp = createChildProcess(sys);
  const child = cp.spawn("cat");
  child.stdin.write("piped ");
  child.stdin.end("data");
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(seenInput, "piped data");
});

test("fork runs `node <module>` as a child", async () => {
  const sys = fakeSys(() => ({ stdout: "" }));
  const cp = createChildProcess(sys);
  const child = cp.fork("/app/worker.js", ["--flag"]);
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(sys.calls[0].line, "'node' '/app/worker.js' '--flag'");
  assert.equal(child.send(), false); // no IPC channel (INV-5)
});
