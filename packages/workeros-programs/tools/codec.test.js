// Validates the WorkerOS codec wasm (crates/workeros-codec) directly: instantiate
// the built module with plain WebAssembly, wrap it in the same facade the guest
// uses, and check every op against real Node (zlib + crypto) in both directions.
// Skipped when the wasm hasn't been built (`npm run build:codec`).
import test from "node:test";
import assert from "node:assert";
import realZlib from "node:zlib";
import realCrypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { codecFromExports } from "../src/node/wasm-codec.js";

const wasmPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "codec", "codec.wasm");
const built = existsSync(wasmPath);
const opts = { skip: built ? false : "codec.wasm not built (run: npm run build:codec)" };

let codec = null;
if (built) {
  const bytes = new Uint8Array(readFileSync(wasmPath));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  codec = codecFromExports(instance.exports);
}

const bytes = (s) => new TextEncoder().encode(s);
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const SAMPLES = [
  new Uint8Array(0),
  bytes("a"),
  bytes("hello world"),
  bytes("ab".repeat(10000)),
  bytes("the quick brown fox. ".repeat(1000)),
  (() => { const b = new Uint8Array(4096); for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761) & 0xff; return b; })(),
];

test("wasm DEFLATE ↔ real Node inflate (both directions)", opts, () => {
  for (const input of SAMPLES) {
    assert.ok(eq(realZlib.inflateRawSync(codec.deflateRaw(input)), input), "Node reads our deflate");
    assert.ok(eq(codec.inflateRaw(realZlib.deflateRawSync(input)), input), "we read Node's deflate");
    assert.ok(eq(codec.inflateRaw(codec.deflateRaw(input)), input), "self round-trip");
  }
});

test("wasm inflate throws on corrupt input", opts, () => {
  assert.throws(() => codec.inflateRaw(bytes("\xff\xff\xff not deflate")), /invalid|corrupt/i);
});

test("wasm crc32 / adler32 match real Node zlib", opts, () => {
  for (const input of SAMPLES) {
    assert.equal(codec.crc32(input), realZlib.crc32(input, 0));
    // Adler-32 is the zlib trailer; verify via a zlib wrap round-trip’s checksum.
    const wrapped = realZlib.deflateSync(input);
    const adler = (wrapped[wrapped.length - 4] << 24) | (wrapped[wrapped.length - 3] << 16) | (wrapped[wrapped.length - 2] << 8) | wrapped[wrapped.length - 1];
    assert.equal(codec.adler32(input), adler >>> 0);
  }
});

test("wasm hashes match real Node crypto", opts, () => {
  const algos = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];
  for (const input of SAMPLES) {
    for (const algo of algos) {
      const want = realCrypto.createHash(algo).update(Buffer.from(input)).digest("hex");
      assert.equal(Buffer.from(codec[algo](input)).toString("hex"), want, `${algo} of ${input.length}B`);
    }
  }
});
