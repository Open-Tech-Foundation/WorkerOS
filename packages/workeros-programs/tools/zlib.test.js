// Functional tests for the guest node:zlib shim. The strong check is *interop
// with real Node's zlib* (available under `node --test`): Node's inflate must
// decode our deflate, and our inflate must decode Node's deflate — proving both
// halves of the codec against a reference implementation, in both directions.
import test from "node:test";
import assert from "node:assert";
import realZlib from "node:zlib";
import { Buffer } from "../src/node/buffer.js";
import { zlib } from "../src/node/zlib.js";
import { stream as streamModule } from "../src/node/stream.js";

globalThis.Buffer = Buffer;

// A spread of inputs: empty, tiny, highly repetitive (long matches), text, and
// incompressible random bytes (forces literals + valid Huffman throughout).
const SAMPLES = {
  empty: Buffer.alloc(0),
  tiny: Buffer.from("a"),
  abc: Buffer.from("abc"),
  repetitive: Buffer.from("ab".repeat(5000)),
  runOfA: Buffer.from("a".repeat(100000)),
  text: Buffer.from("the quick brown fox jumps over the lazy dog. ".repeat(400)),
  random: (() => { const b = Buffer.alloc(4096); for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761) & 0xff; return b; })(),
};

const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

for (const [name, input] of Object.entries(SAMPLES)) {
  test(`gzip: real Node decodes our output — ${name}`, () => {
    const ours = zlib.gzipSync(input);
    assert.ok(eq(realZlib.gunzipSync(ours), input), "Node gunzip of our gzip must match input");
  });

  test(`gzip: we decode real Node's output — ${name}`, () => {
    assert.ok(eq(zlib.gunzipSync(realZlib.gzipSync(input)), input));
  });

  test(`deflate (zlib): interop both ways — ${name}`, () => {
    assert.ok(eq(realZlib.inflateSync(zlib.deflateSync(input)), input));
    assert.ok(eq(zlib.inflateSync(realZlib.deflateSync(input)), input)); // Node uses dynamic Huffman
  });

  test(`deflateRaw: interop both ways — ${name}`, () => {
    assert.ok(eq(realZlib.inflateRawSync(zlib.deflateRawSync(input)), input));
    assert.ok(eq(zlib.inflateRawSync(realZlib.deflateRawSync(input)), input));
  });

  test(`self round-trip — ${name}`, () => {
    assert.ok(eq(zlib.gunzipSync(zlib.gzipSync(input)), input));
    assert.ok(eq(zlib.inflateSync(zlib.deflateSync(input)), input));
    assert.ok(eq(zlib.inflateRawSync(zlib.deflateRawSync(input)), input));
  });
}

test("compression actually shrinks repetitive input", () => {
  const input = Buffer.from("a".repeat(100000));
  assert.ok(zlib.gzipSync(input).length < input.length / 10);
});

test("string input is treated as utf8", () => {
  assert.ok(eq(zlib.gunzipSync(zlib.gzipSync("héllo wörld")), Buffer.from("héllo wörld", "utf8")));
});

test("unzipSync auto-detects gzip vs zlib vs raw", () => {
  const data = Buffer.from("detect me ".repeat(50));
  assert.ok(eq(zlib.unzipSync(realZlib.gzipSync(data)), data));
  assert.ok(eq(zlib.unzipSync(realZlib.deflateSync(data)), data));
  assert.ok(eq(zlib.unzipSync(realZlib.deflateRawSync(data)), data));
});

test("gunzipSync rejects a corrupt checksum", () => {
  const good = zlib.gzipSync(Buffer.from("payload"));
  const bad = Buffer.from(good);
  bad[bad.length - 5] ^= 0xff; // flip a CRC byte
  assert.throws(() => zlib.gunzipSync(bad), /checksum/);
});

test("async callback form matches the sync result", async () => {
  const input = Buffer.from("async round trip ".repeat(30));
  const gz = await new Promise((res, rej) => zlib.gzip(input, (e, b) => (e ? rej(e) : res(b))));
  assert.ok(eq(realZlib.gunzipSync(gz), input));
  const back = await new Promise((res, rej) => zlib.gunzip(gz, (e, b) => (e ? rej(e) : res(b))));
  assert.ok(eq(back, input));
  // Options object before the callback is accepted (and ignored).
  const gz2 = await new Promise((res, rej) => zlib.gzip(input, { level: 9 }, (e, b) => (e ? rej(e) : res(b))));
  assert.ok(eq(realZlib.gunzipSync(gz2), input));
});

test("crc32 matches Node and constants are present", () => {
  assert.equal(zlib.crc32(Buffer.from("The quick brown fox jumps over the lazy dog")), 0x414fa339);
  assert.equal(zlib.constants.Z_DEFLATED, 8);
  assert.equal(zlib.constants.Z_FINISH, 4);
});

test("stream constructors are exposed and are Transform streams", () => {
  const gz = zlib.createGzip();
  assert.ok(gz instanceof zlib.Gzip);
  assert.ok(gz instanceof streamModule.Transform);
  assert.equal(typeof zlib.createGunzip, "function");
  assert.equal(typeof zlib.createDeflate, "function");
  assert.equal(typeof zlib.createInflate, "function");
  assert.equal(typeof zlib.createDeflateRaw, "function");
  assert.equal(typeof zlib.createInflateRaw, "function");
  assert.equal(typeof zlib.createUnzip, "function");
});

async function collect(stream, writeChunks) {
  const out = [];
  stream.on("data", (chunk) => out.push(Buffer.from(chunk)));
  if (writeChunks) for (const chunk of writeChunks) stream.write(chunk);
  stream.end();
  await streamModule.promises.finished(stream);
  return Buffer.concat(out);
}

test("createGzip buffers chunked writes and emits gzip output on end", async () => {
  const input = Buffer.from("stream gzip ".repeat(200));
  const out = await collect(zlib.createGzip(), [
    input.subarray(0, 50),
    input.subarray(50, 175),
    input.subarray(175),
  ]);
  assert.ok(eq(realZlib.gunzipSync(out), input));
});

test("createGunzip decodes chunked gzip input", async () => {
  const input = Buffer.from("stream gunzip ".repeat(200));
  const gz = realZlib.gzipSync(input);
  const out = await collect(zlib.createGunzip(), [
    gz.subarray(0, 10),
    gz.subarray(10, 80),
    gz.subarray(80),
  ]);
  assert.ok(eq(out, input));
});

test("deflate/inflate stream pairs round-trip", async () => {
  const input = Buffer.from("stream deflate ".repeat(180));
  const deflated = await collect(zlib.createDeflate(), [input.subarray(0, 90), input.subarray(90)]);
  assert.ok(eq(realZlib.inflateSync(deflated), input));
  const inflated = await collect(zlib.createInflate(), [deflated.subarray(0, 20), deflated.subarray(20)]);
  assert.ok(eq(inflated, input));
});

test("raw and unzip stream variants interoperate with real Node", async () => {
  const input = Buffer.from("stream raw ".repeat(220));
  const raw = await collect(zlib.createDeflateRaw(), [input]);
  assert.ok(eq(realZlib.inflateRawSync(raw), input));
  const rawBack = await collect(zlib.createInflateRaw(), [raw.subarray(0, 13), raw.subarray(13)]);
  assert.ok(eq(rawBack, input));

  const gz = realZlib.gzipSync(input);
  const unzipped = await collect(zlib.createUnzip(), [gz.subarray(0, 25), gz.subarray(25)]);
  assert.ok(eq(unzipped, input));
});
