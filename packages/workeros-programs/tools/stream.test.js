import { test } from "node:test";
import assert from "node:assert/strict";

import stream, {
  Duplex,
  PassThrough,
  Readable,
  Transform,
  Writable,
  finished,
  pipeline,
  promises,
} from "../src/node/stream.js";
import { makeBuiltins } from "../src/node/require-runtime.js";

test("module surface exports the core classes", () => {
  assert.equal(stream.Readable, Readable);
  assert.equal(stream.Writable, Writable);
  assert.equal(stream.Duplex, Duplex);
  assert.equal(stream.Transform, Transform);
  assert.equal(stream.PassThrough, PassThrough);
});

test("Readable.from emits iterable values and ends", async () => {
  const r = Readable.from(["a", "b"]);
  const seen = [];
  await new Promise((resolve, reject) => {
    r.on("data", (chunk) => seen.push(String(chunk)));
    r.on("end", resolve);
    r.on("error", reject);
  });
  assert.deepEqual(seen, ["a", "b"]);
});

test("pipe moves data into a Writable and finishes it", async () => {
  const got = [];
  class Sink extends Writable {
    _write(chunk, _enc, cb) {
      got.push(String(chunk));
      cb();
    }
  }
  const sink = new Sink();
  await new Promise((resolve, reject) => {
    sink.on("finish", resolve);
    sink.on("error", reject);
    Readable.from(["x", "y"]).pipe(sink);
  });
  assert.deepEqual(got, ["x", "y"]);
});

test("Transform rewrites chunks and PassThrough preserves them", async () => {
  class Upper extends Transform {
    _transform(chunk, _enc, cb) {
      cb(null, String(chunk).toUpperCase());
    }
  }
  const pass = new PassThrough();
  const out = [];
  await new Promise((resolve, reject) => {
    pass.on("data", (chunk) => out.push(String(chunk)));
    pass.on("end", resolve);
    pass.on("error", reject);
    Readable.from(["ab", "cd"]).pipe(new Upper()).pipe(pass);
  });
  assert.deepEqual(out, ["AB", "CD"]);
});

test("finished callback and promises.finished resolve on stream completion", async () => {
  const sink = new PassThrough();
  const cbDone = new Promise((resolve, reject) => {
    finished(sink, (err) => (err ? reject(err) : resolve()));
  });
  const promiseDone = promises.finished(sink);
  // A PassThrough is a Duplex: `finished` waits for BOTH sides to complete, so the
  // buffered readable side must be drained or `finished` never fires (this matches
  // real node:stream — the previous hand-rolled subset fired on `finish` alone).
  sink.resume();
  sink.end("ok");
  await Promise.all([cbDone, promiseDone]);
  assert.equal(sink.writableFinished, true);
});

test("pipeline composes multiple streams", async () => {
  class Collect extends Writable {
    constructor() {
      super();
      this.buf = [];
    }
    _write(chunk, _enc, cb) {
      this.buf.push(String(chunk));
      cb();
    }
  }
  class Wrap extends Transform {
    _transform(chunk, _enc, cb) {
      cb(null, `<${String(chunk)}>`);
    }
  }
  const sink = new Collect();
  await promises.pipeline(Readable.from(["a", "b"]), new Wrap(), sink);
  assert.deepEqual(sink.buf, ["<a>", "<b>"]);
});

test("end and close are emitted once", async () => {
  const r = Readable.from(["x"]);
  let ends = 0;
  let closes = 0;
  await new Promise((resolve, reject) => {
    r.on("data", () => {});
    r.on("end", () => { ends++; });
    r.on("close", () => { closes++; resolve(); });
    r.on("error", reject);
  });
  assert.equal(ends, 1);
  assert.equal(closes, 1);
});

test("stream is registered as a builtin", () => {
  const builtins = makeBuiltins({
    syncFs: {
      open() { throw new Error("Noent"); },
      read() { return new Uint8Array(0); },
      write() { return 0; },
      close() {},
      seek() { return 0; },
      stat() { throw new Error("Noent"); },
      lstat() { throw new Error("Noent"); },
      symlink() {},
      readlink() { return ""; },
      readdir() { return []; },
      mkdir() {},
      unlink() {},
      rmdir() {},
      rename() {},
      watchAdd() { return 0; },
      watchRemove() {},
    },
    onFsEvent() {},
  });
  assert.equal(builtins.get("stream").Readable, Readable);
});
