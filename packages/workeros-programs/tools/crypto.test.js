// Functional tests for the guest node:crypto shim. Hash/HMAC outputs are checked
// against known-answer vectors (identical to real Node); randomness is exercised
// against the host Web Crypto (`globalThis.crypto`, present under `node --test`).
import test from "node:test";
import assert from "node:assert";
import { Buffer } from "../src/node/buffer.js";
import { crypto } from "../src/node/crypto.js";

globalThis.Buffer = Buffer;

const hex = (algo, data) => crypto.createHash(algo).update(data).digest("hex");

test("hash known-answer vectors ('' and 'abc')", () => {
  assert.equal(hex("md5", ""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(hex("md5", "abc"), "900150983cd24fb0d6963f7d28e17f72");

  assert.equal(hex("sha1", ""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(hex("sha1", "abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");

  assert.equal(hex("sha224", "abc"), "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7");

  assert.equal(hex("sha256", ""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex("sha256", "abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  assert.equal(
    hex("sha384", "abc"),
    "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
  );
  assert.equal(
    hex("sha512", "abc"),
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
      "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
  );
});

test("multi-block input (1,000,000 × 'a')", () => {
  const data = "a".repeat(1_000_000);
  assert.equal(hex("sha256", data), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  assert.equal(hex("sha1", data), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
  assert.equal(hex("md5", data), "7707d6ae4e027c70eea2a935c2296f21");
  assert.equal(
    hex("sha512", data),
    "e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973eb" +
      "de0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b",
  );
});

test("streaming update() matches one-shot; accepts Buffer input", () => {
  const oneShot = hex("sha256", "hello world");
  const streamed = crypto
    .createHash("sha256")
    .update("hello ")
    .update(Buffer.from("world"))
    .digest("hex");
  assert.equal(streamed, oneShot);
});

test("algorithm names are case/separator-insensitive", () => {
  assert.equal(hex("SHA-256", "abc"), hex("sha256", "abc"));
  assert.equal(hex("SHA256", "abc"), hex("sha256", "abc"));
});

test("digest() default returns a Buffer; other encodings are strings", () => {
  const buf = crypto.createHash("sha256").update("abc").digest();
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.length, 32);
  assert.equal(buf.toString("hex"), hex("sha256", "abc"));
  assert.match(crypto.createHash("sha256").update("abc").digest("base64"), /=$/);
});

test("digest twice throws", () => {
  const h = crypto.createHash("sha256").update("x");
  h.digest();
  assert.throws(() => h.digest(), /Digest already called/);
});

test("unknown algorithm throws", () => {
  assert.throws(() => crypto.createHash("sha3-256"), /not supported/);
});

test("HMAC known-answer vectors (RFC 4231 / 2202)", () => {
  // RFC 2202: HMAC-MD5 / HMAC-SHA1 with key "Jefe", data "what do ya want ...".
  const hmac = (algo, key, data) => crypto.createHmac(algo, key).update(data).digest("hex");
  assert.equal(hmac("md5", "Jefe", "what do ya want for nothing?"), "750c783e6ab0b503eaa86e310a5db738");
  assert.equal(hmac("sha1", "Jefe", "what do ya want for nothing?"), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
  assert.equal(
    hmac("sha256", "Jefe", "what do ya want for nothing?"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
  // RFC 4231 test case 2 for SHA-512.
  assert.equal(
    hmac("sha512", "Jefe", "what do ya want for nothing?"),
    "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554" +
      "9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737",
  );
  // A key longer than the block is hashed first — exercise that branch.
  assert.equal(crypto.createHmac("sha256", "k".repeat(200)).update("data").digest("hex").length, 64);
});

test("randomBytes is host-backed, sized, and non-deterministic", () => {
  const a = crypto.randomBytes(32);
  const b = crypto.randomBytes(32);
  assert.ok(Buffer.isBuffer(a));
  assert.equal(a.length, 32);
  assert.notEqual(a.toString("hex"), b.toString("hex"));
  assert.equal(crypto.randomBytes(0).length, 0);
  // Larger than the 65536 getRandomValues cap — chunked fill must still work.
  assert.equal(crypto.randomBytes(100000).length, 100000);
});

test("randomBytes(size, cb) delivers asynchronously", async () => {
  const buf = await new Promise((resolve, reject) =>
    crypto.randomBytes(16, (err, b) => (err ? reject(err) : resolve(b))),
  );
  assert.equal(buf.length, 16);
});

test("randomFillSync fills only the requested window", () => {
  const buf = Buffer.alloc(8);
  crypto.randomFillSync(buf, 2, 4);
  assert.equal(buf[0], 0);
  assert.equal(buf[1], 0);
  assert.equal(buf[6], 0);
  assert.equal(buf[7], 0);
});

test("randomUUID is a well-formed v4 UUID", () => {
  const uuid = crypto.randomUUID();
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(crypto.randomUUID(), crypto.randomUUID());
});

test("randomInt is within range for both overloads", () => {
  for (let i = 0; i < 200; i++) {
    const x = crypto.randomInt(10);
    assert.ok(x >= 0 && x < 10);
    const y = crypto.randomInt(5, 8);
    assert.ok(y >= 5 && y < 8);
  }
  assert.throws(() => crypto.randomInt(5, 5), /max must be greater/);
});

test("timingSafeEqual compares equal-length buffers", () => {
  assert.equal(crypto.timingSafeEqual(Buffer.from("abcd"), Buffer.from("abcd")), true);
  assert.equal(crypto.timingSafeEqual(Buffer.from("abcd"), Buffer.from("abce")), false);
  assert.throws(() => crypto.timingSafeEqual(Buffer.from("ab"), Buffer.from("abc")), /same byte length/);
});

test("getHashes lists the supported algorithms; webcrypto passes through the host", () => {
  assert.deepEqual(crypto.getHashes().sort(), ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"]);
  assert.equal(crypto.webcrypto, globalThis.crypto);
});
