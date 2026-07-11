// Functional tests for the guest node:zlib shim. The strong check is *interop
// with real Node's zlib* (available under `node --test`): Node's inflate must
// decode our deflate, and our inflate must decode Node's deflate — proving both
// halves of the codec against a reference implementation, in both directions.
import test from "node:test";
import assert from "node:assert";
import realZlib from "node:zlib";
import { Buffer } from "../src/node/buffer.js";
import { zlib } from "../src/node/zlib.js";

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
