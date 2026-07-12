// `node:stream` — the real Node streams core, vendored via `readable-stream`.
//
// `readable-stream` is Node's own `lib/internal/streams/*` published to npm with
// the native/internal bindings stripped for userland — the exact implementation a
// large share of the npm ecosystem already `require('readable-stream')` directly.
// Making WorkerOS's `node:stream` *be* that code gives packages battle-tested
// objectMode, highWaterMark backpressure, cork/uncork, destroy/_destroy/_final,
// async-iterator operators (.map/.filter/.take/…), compose(), addAbortSignal, and
// Web Streams interop (Readable.toWeb/fromWeb) — instead of a hand-rolled subset.
//
// We import `lib/stream.js` (the implementation aggregator) directly, bypassing
// the package's `lib/ours/index.js` entry: that entry does `require('stream')`,
// which — since we ARE `node:stream` — would be a circular self-require. The
// aggregator has no such require.
//
// readable-stream's bare deps (`buffer`, `events`, `string_decoder`, `process/`,
// `abort-controller`) are remapped to WorkerOS's own builtins at bundle time by
// `readableStreamAliasPlugin` in tools/bundle.mjs, so a single Buffer/EventEmitter
// identity is shared across fs ↔ stream ↔ net. INV-1 holds: pure userland.
import Stream from "readable-stream/lib/stream.js";
import { Buffer } from "./buffer.js";

export const {
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  pipeline,
  finished,
  compose,
  destroy,
  addAbortSignal,
  isDisturbed,
  isErrored,
  isReadable,
  isWritable,
  isDestroyed,
  setDefaultHighWaterMark,
  getDefaultHighWaterMark,
  _isUint8Array,
  _uint8ArrayToBuffer,
} = Stream;

// `Stream.promises` is a lazy getter on the aggregator ({ pipeline, finished }).
export const promises = Stream.promises;

// `node:stream/web` — the WHATWG Web Streams. The browser/worker implements these
// natively as globals; Node re-exports the identical set under this specifier.
export const web = {
  ReadableStream: globalThis.ReadableStream,
  ReadableStreamDefaultReader: globalThis.ReadableStreamDefaultReader,
  ReadableStreamBYOBReader: globalThis.ReadableStreamBYOBReader,
  ReadableStreamDefaultController: globalThis.ReadableStreamDefaultController,
  ReadableByteStreamController: globalThis.ReadableByteStreamController,
  ReadableStreamBYOBRequest: globalThis.ReadableStreamBYOBRequest,
  WritableStream: globalThis.WritableStream,
  WritableStreamDefaultWriter: globalThis.WritableStreamDefaultWriter,
  WritableStreamDefaultController: globalThis.WritableStreamDefaultController,
  TransformStream: globalThis.TransformStream,
  TransformStreamDefaultController: globalThis.TransformStreamDefaultController,
  ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
  CountQueuingStrategy: globalThis.CountQueuingStrategy,
};

// `node:stream/consumers` — drain any Node stream, Web ReadableStream, or async
// iterable of chunks into a single value. `for await` covers all three in a modern
// engine (Node Readable and Web ReadableStream are both async-iterable here).
async function collect(source) {
  const chunks = [];
  for await (const chunk of source) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export const consumers = {
  async arrayBuffer(source) {
    const b = await collect(source);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  async blob(source) {
    return new Blob([await collect(source)]);
  },
  async buffer(source) {
    return collect(source);
  },
  async text(source) {
    return (await collect(source)).toString("utf8");
  },
  async json(source) {
    return JSON.parse((await collect(source)).toString("utf8"));
  },
};

// The module object registered as the `node:stream` builtin (import + require).
// `Stream.Stream === Stream`, so the default export, the `stream` binding, and the
// `Stream` named export are all the same object — matching Node.
export { Stream };
export const stream = Stream;
export default Stream;
