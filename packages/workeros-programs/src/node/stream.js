// `node:stream` — a pragmatic subset of Node streams for the WorkerOS runtime.
//
// GUEST code (INV-1): pure userland over EventEmitter. This aims at the
// high-frequency compatibility surface npm tooling feature-detects or uses
// lightly: Readable/Writable/Duplex/Transform/PassThrough, pipe(), pipeline(),
// finished(), and Readable.from(). It is not a full backpressure/fd stream
// implementation yet; the goal is coherent semantics, not byte-perfect Node.

import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";

const toBuffer = (chunk, encoding) => {
  if (chunk == null) return null;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, encoding || "utf8");
  if (Array.isArray(chunk)) return Buffer.from(chunk);
  return Buffer.from(chunk);
};

class Stream extends EventEmitter {
  pipe(dest, options) {
    return Readable.prototype.pipe.call(this, dest, options);
  }
}

class Readable extends Stream {
  constructor(options = {}) {
    super();
    this.readable = true;
    this.destroyed = false;
    this.readableEnded = false;
    this.readableFlowing = false;
    this._endEmitted = false;
    this._closeEmitted = false;
    this._encoding = options.encoding || null;
    this._queue = [];
    this._awaitReadable = false;
    this._pipes = new Set();
    this.on("newListener", (ev) => {
      if (ev === "data" && !this.readableFlowing) this.resume();
    });
  }

  _coerce(chunk) {
    if (this._encoding && chunk instanceof Uint8Array) return Buffer.from(chunk).toString(this._encoding);
    return chunk instanceof Uint8Array ? Buffer.from(chunk) : chunk;
  }

  push(chunk, encoding) {
    if (this.destroyed) return false;
    if (chunk === null) {
      this.readableEnded = true;
      this.readable = false;
      this._drainQueue();
      this._maybeEmitEnd();
      return false;
    }
    const buf = this._coerce(toBuffer(chunk, encoding));
    this._queue.push(buf);
    if (this.readableFlowing || this._awaitReadable) this._drainQueue();
    return true;
  }

  unshift(chunk) {
    if (chunk == null) return false;
    this._queue.unshift(this._coerce(toBuffer(chunk)));
    return true;
  }

  _drainQueue() {
    if (this.destroyed) return;
    if (this.readableFlowing) {
      while (this._queue.length) this.emit("data", this._queue.shift());
      if (this.readableEnded) this._maybeEmitEnd();
    } else if (this._awaitReadable && this._queue.length) {
      this._awaitReadable = false;
      queueMicrotask(() => this.emit("readable"));
    }
  }

  _maybeEmitEnd() {
    if (this._endEmitted || this._queue.length !== 0) return;
    this._endEmitted = true;
    queueMicrotask(() => {
      this.emit("end");
      this._emitCloseOnce();
    });
  }

  _emitCloseOnce() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close");
  }

  read() {
    const chunk = this._queue.shift() ?? null;
    if (chunk !== null) return chunk;
    if (!this.readableEnded) this._awaitReadable = true;
    return null;
  }

  pause() {
    this.readableFlowing = false;
    return this;
  }

  resume() {
    this.readableFlowing = true;
    this._drainQueue();
    return this;
  }

  setEncoding(enc) {
    this._encoding = enc;
    this._queue = this._queue.map((chunk) =>
      chunk instanceof Uint8Array ? Buffer.from(chunk).toString(enc) : String(chunk));
    return this;
  }

  pipe(dest, options = {}) {
    const onData = (chunk) => {
      const ok = dest.write(chunk);
      if (ok === false && typeof this.pause === "function") this.pause();
    };
    const onDrain = () => { if (typeof this.resume === "function") this.resume(); };
    const onEnd = () => { if (options.end !== false && typeof dest.end === "function") dest.end(); };
    const onError = (err) => dest.emit?.("error", err);
    this.on("data", onData);
    this.on("end", onEnd);
    this.on("error", onError);
    dest.on?.("drain", onDrain);
    this._pipes.add(dest);
    dest.emit?.("pipe", this);
    this.resume();
    const unpipe = () => {
      this.off("data", onData);
      this.off("end", onEnd);
      this.off("error", onError);
      dest.off?.("drain", onDrain);
      this._pipes.delete(dest);
      dest.emit?.("unpipe", this);
    };
    dest.once?.("close", unpipe);
    return dest;
  }

  unpipe(dest) {
    if (!dest) {
      for (const d of [...this._pipes]) this.unpipe(d);
      return this;
    }
    dest.emit?.("unpipe", this);
    this._pipes.delete(dest);
    return this;
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this._queue.length = 0;
    if (err) this.emit("error", err);
    queueMicrotask(() => this._emitCloseOnce());
    return this;
  }

  static from(iterable, options = {}) {
    const r = new Readable(options);
    queueMicrotask(async () => {
      try {
        for await (const chunk of iterable) r.push(chunk);
        r.push(null);
      } catch (e) {
        r.destroy(e instanceof Error ? e : new Error(String(e)));
      }
    });
    return r;
  }
}

class Writable extends Stream {
  constructor(options = {}) {
    super();
    this.writable = true;
    this.destroyed = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this._closeEmitted = false;
    this._defaultEncoding = options.defaultEncoding || "utf8";
    this._ending = false;
  }

  _write(chunk, encoding, cb) {
    cb();
  }

  write(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (!this.writable || this.writableEnded) {
      const err = new Error("write after end");
      if (cb) queueMicrotask(() => cb(err));
      else queueMicrotask(() => this.emit("error", err));
      return false;
    }
    const buf = toBuffer(chunk, encoding || this._defaultEncoding);
    this._write(buf, encoding || this._defaultEncoding, (err) => {
      if (err) {
        if (cb) cb(err);
        this.emit("error", err);
        return;
      }
      if (cb) cb();
      this.emit("drain");
      if (this._ending && !this.writableFinished) this._finish();
    });
    return true;
  }

  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (chunk != null) this.write(chunk, encoding);
    this._ending = true;
    this.writableEnded = true;
    if (!this.writableFinished) this._finish();
    if (cb) queueMicrotask(cb);
    return this;
  }

  _finish() {
    if (this.writableFinished) return;
    this.writable = false;
    this.writableFinished = true;
    queueMicrotask(() => {
      this.emit("finish");
      this._emitCloseOnce();
    });
  }

  _emitCloseOnce() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close");
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    if (err) this.emit("error", err);
    queueMicrotask(() => this._emitCloseOnce());
    return this;
  }
}

class Duplex extends Readable {
  constructor(options = {}) {
    super(options);
    this.writable = true;
    this.writableEnded = false;
    this.writableFinished = false;
    this._defaultEncoding = options.defaultEncoding || "utf8";
    this._ending = false;
  }

  _write(chunk, encoding, cb) {
    cb();
  }

  write(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (!this.writable || this.writableEnded) {
      const err = new Error("write after end");
      if (cb) queueMicrotask(() => cb(err));
      else queueMicrotask(() => this.emit("error", err));
      return false;
    }
    const buf = toBuffer(chunk, encoding || this._defaultEncoding);
    this._write(buf, encoding || this._defaultEncoding, (err) => {
      if (err) {
        if (cb) cb(err);
        this.emit("error", err);
        return;
      }
      if (cb) cb();
      this.emit("drain");
      if (this._ending && !this.writableFinished) this._finishWritable();
    });
    return true;
  }

  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    if (chunk != null) this.write(chunk, encoding);
    this._ending = true;
    this.writableEnded = true;
    if (!this.writableFinished) this._finishWritable();
    if (cb) queueMicrotask(cb);
    return this;
  }

  _finishWritable() {
    if (this.writableFinished) return;
    this.writable = false;
    this.writableFinished = true;
    queueMicrotask(() => this.emit("finish"));
  }

  destroy(err) {
    super.destroy(err);
    this.writable = false;
    return this;
  }
}

class Transform extends Duplex {
  constructor(options = {}) {
    super(options);
  }

  _transform(chunk, encoding, cb) {
    cb(null, chunk);
  }

  _write(chunk, encoding, cb) {
    this._transform(chunk, encoding, (err, out) => {
      if (err) return cb(err);
      if (out != null) this.push(out);
      cb();
    });
  }

  end(chunk, encoding, cb) {
    super.end(chunk, encoding, cb);
    const flush = this._flush;
    if (typeof flush === "function") {
      flush.call(this, (err, out) => {
        if (err) this.emit("error", err);
        else if (out != null) this.push(out);
        this.push(null);
      });
    } else {
      this.push(null);
    }
    return this;
  }
}

class PassThrough extends Transform {
  _transform(chunk, _encoding, cb) {
    cb(null, chunk);
  }
}

function finished(stream, cb) {
  const done = (err) => {
    cleanup();
    if (cb) cb(err);
  };
  const onEnd = () => done();
  const onFinish = () => done();
  const onClose = () => done();
  const onError = (err) => done(err);
  const cleanup = () => {
    stream.off?.("end", onEnd);
    stream.off?.("finish", onFinish);
    stream.off?.("close", onClose);
    stream.off?.("error", onError);
  };
  stream.on?.("end", onEnd);
  stream.on?.("finish", onFinish);
  stream.on?.("close", onClose);
  stream.on?.("error", onError);
  return cleanup;
}

function pipeline(...args) {
  const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
  const streams = args.flat();
  if (streams.length < 2) throw new Error("pipeline requires at least two streams");
  let settled = false;
  const settle = (err) => {
    if (settled) return;
    settled = true;
    if (cb) cb(err);
  };
  for (let i = 0; i < streams.length - 1; i++) streams[i].pipe(streams[i + 1]);
  for (const s of streams) {
    finished(s, (err) => {
      if (err) settle(err);
      else if (s === streams[streams.length - 1]) settle();
    });
  }
  return streams[streams.length - 1];
}

const promises = {
  finished(stream) {
    return new Promise((resolve, reject) => {
      finished(stream, (err) => (err ? reject(err) : resolve()));
    });
  },
  pipeline(...streams) {
    return new Promise((resolve, reject) => {
      pipeline(...streams, (err) => (err ? reject(err) : resolve()));
    });
  },
};

const stream = {
  Stream,
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  pipeline,
  finished,
  promises,
};

stream.default = stream;

export {
  stream,
  Stream,
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  pipeline,
  finished,
  promises,
};

export default stream;
