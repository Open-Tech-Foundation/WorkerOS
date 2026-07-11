import test from "node:test";
import assert from "node:assert/strict";
import { createChildProcess } from "../src/node/child-process.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s) => enc.encode(s);

// A fake `sys` for both surfaces child_process uses:
//  • the streaming async path — spawnChild + onChildEvent + childKill
//  • the blocking sync path   — execCaptureSync
// `respond(key, input)` -> { code, stdout, stderr, throw } answers a launch, keyed
// by the joined argv (async) or the command line (sync). Records every call.
function fakeSys(respond) {
  let dispatch = null;
  const calls = [];
  return {
    calls,
    onChildEvent: (cb) => { dispatch = cb; },
    spawnChild: async ({ argv, env, cwd, input }) => {
      const line = argv.join(" ");
      calls.push({ argv, line, env, cwd, input: input ? dec.decode(input) : null });
      const r = respond(line, input) || {};
      if (r.throw) throw new Error(r.throw);
      const pid = 1000 + calls.length;
      // Deliver stdout/stderr/exit on a later turn — the real kernel always sends
      // the spawn reply (which registers the child) before any CHILD_* message.
      setTimeout(() => {
        if (r.stdout) dispatch(pid, "stdout", bytes(r.stdout));
        if (r.stderr) dispatch(pid, "stderr", bytes(r.stderr));
        dispatch(pid, "exit", { code: r.code || 0 });
      }, 0);
      return { pid };
    },
    childKill: (pid, sig) => { calls.push({ kill: pid, sig }); },
    execCaptureSync: (line, input) => {
      calls.push({ line, input: input ? dec.decode(input) : null });
      const r = respond(line, input) || {};
      return { code: r.code || 0, stdout: bytes(r.stdout || ""), stderr: bytes(r.stderr || "") };
    },
  };
}

// ---- synchronous forms (blocking capture) ---------------------------------

test("execSync returns stdout as a Buffer by default, string with an encoding", () => {
  const sys = fakeSys((line) => (line === "echo hi" ? { stdout: "hi\n" } : {}));
  const cp = createChildProcess(sys);
  const buf = cp.execSync("echo hi");
  assert.ok(buf instanceof Uint8Array);
  assert.equal(dec.decode(buf), "hi\n");
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

test("cwd and env are wrapped in an isolating subshell (sync path)", () => {
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

// ---- streaming async forms -------------------------------------------------

test("exec (async) buffers streamed output and calls back", async () => {
  const sys = fakeSys(() => ({ stdout: "hello\n", stderr: "" }));
  const cp = createChildProcess(sys);
  const { out, err } = await new Promise((resolve) => {
    cp.exec("echo hello", (e, out, err) => resolve({ e, out, err }));
  });
  assert.equal(out, "hello\n");
  assert.equal(err, "");
  // exec routes through a shell (sh -c).
  assert.deepEqual(sys.calls[0].argv, ["/bin/sh", "-c", "echo hello"]);
});

test("exec (async) reports a non-zero exit as an Error with .code", async () => {
  const sys = fakeSys(() => ({ code: 3, stderr: "nope" }));
  const cp = createChildProcess(sys);
  const e = await new Promise((resolve) => cp.exec("bad", (e) => resolve(e)));
  assert.ok(e instanceof Error);
  assert.equal(e.code, 3);
  assert.match(e.message, /nope/);
});

test("execFile passes argv verbatim (no shell)", async () => {
  const sys = fakeSys(() => ({ stdout: "" }));
  const cp = createChildProcess(sys);
  await new Promise((resolve) => cp.execFile("git", ["log", "--oneline"], resolve));
  assert.deepEqual(sys.calls[0].argv, ["git", "log", "--oneline"]);
});

test("spawn streams stdout data incrementally, then exit/close", async () => {
  // Two chunks + exit, delivered as separate events — proves incremental delivery.
  const sys = {
    calls: [],
    _dispatch: null,
    onChildEvent(cb) { this._dispatch = cb; },
    spawnChild: async ({ argv }) => {
      sys.calls.push(argv);
      const pid = 7;
      setTimeout(() => {
        sys._dispatch(pid, "stdout", bytes("chunk-1;"));
        setTimeout(() => {
          sys._dispatch(pid, "stdout", bytes("chunk-2"));
          sys._dispatch(pid, "exit", { code: 0 });
        }, 0);
      }, 0);
      return { pid };
    },
    childKill() {},
  };
  const cp = createChildProcess(sys);
  const child = cp.spawn("streamer");
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d.toString()));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.deepEqual(chunks, ["chunk-1;", "chunk-2"]); // two separate data events
  assert.equal(child.exitCode, 0);
});

test("spawn feeds written stdin to the child, launching on end()", async () => {
  let seenInput = null;
  const sys = fakeSys((line, input) => {
    seenInput = input ? dec.decode(input) : null;
    return { stdout: "" };
  });
  const cp = createChildProcess(sys);
  const child = cp.spawn("cat");
  child.stdin.write("piped ");
  child.stdin.end("data");
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(seenInput, "piped data");
});

test("kill signals the child and reports it as code null + signal", async () => {
  const sys = fakeSys(() => ({ code: 143 })); // 128 + SIGTERM
  const cp = createChildProcess(sys);
  const child = cp.spawn("sleep", ["100"]);
  await new Promise((resolve) => child.on("spawn", resolve));
  child.kill();
  const [code, signal] = await new Promise((resolve) =>
    child.on("close", (c, s) => resolve([c, s])),
  );
  assert.equal(code, null);
  assert.equal(signal, "SIGTERM");
  assert.deepEqual(sys.calls.at(-1), { kill: child.pid, sig: 15 });
});

test("spawn emits 'error' when the kernel can't spawn the child", async () => {
  const sys = fakeSys(() => ({ throw: "ENOENT: no such file" }));
  const cp = createChildProcess(sys);
  const child = cp.spawn("does-not-exist");
  const err = await new Promise((resolve) => child.on("error", resolve));
  assert.match(err.message, /ENOENT/);
});

test("fork runs `node <module>` with no IPC channel", async () => {
  const sys = fakeSys(() => ({ stdout: "" }));
  const cp = createChildProcess(sys);
  const child = cp.fork("/app/worker.js", ["--flag"]);
  await new Promise((resolve) => child.on("close", resolve));
  assert.deepEqual(sys.calls[0].argv, ["node", "/app/worker.js", "--flag"]);
  assert.equal(child.send(), false);
});
