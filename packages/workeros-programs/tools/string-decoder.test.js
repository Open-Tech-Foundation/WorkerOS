import test from "node:test";
import assert from "node:assert/strict";
import realMod from "node:string_decoder";
import { stringDecoder as ours } from "../src/node/string_decoder.js";
import { createNodeRuntime } from "../src/node/require-runtime.js";
import { createFs } from "../src/node/fs.js";
import { createFakeSyncFs } from "./fake-syncfs.js";

function fakeSys() {
  const syncFs = createFakeSyncFs();
  return {
    syncFs,
    open: async (p, o = {}) => syncFs.open(p, o),
    read: async (fd, max) => syncFs.read(fd, max),
    close: async (fd) => syncFs.close(fd),
    stat: async (p) => syncFs.stat(p),
  };
}

function runCase(mod, enc, parts, endArg) {
  const d = new mod.StringDecoder(enc);
  const out = parts.map((p) => d.write(p));
  const end = endArg === undefined ? d.end() : d.end(endArg);
  return { encoding: d.encoding, out, end };
}

test("matches host node:string_decoder for split multibyte and byte-oriented encodings", () => {
  const cases = [
    ["utf8", [Buffer.from([0xe2]), Buffer.from([0x82]), Buffer.from([0xac])]],
    ["utf16le", [Buffer.from([0x61]), Buffer.from([0x00, 0x62, 0x00])]],
    ["base64", [Buffer.from("a"), Buffer.from("bc")]],
    ["latin1", [Buffer.from([0x61, 0xff])]],
    ["ascii", [Buffer.from([0x61, 0xff])]],
    ["hex", [Buffer.from([0x61, 0x62, 0x63])]],
  ];
  for (const [enc, parts] of cases) {
    assert.deepEqual(runCase(ours, enc, parts), runCase(realMod, enc, parts), enc);
  }
});

test("utf8 end emits replacement for a trailing incomplete sequence", () => {
  assert.deepEqual(
    runCase(ours, "utf8", [Buffer.from([0xe2, 0x82])]),
    runCase(realMod, "utf8", [Buffer.from([0xe2, 0x82])]),
  );
});

test("aliases and unknown encodings match the host module shape", () => {
  assert.equal(new ours.StringDecoder("utf-8").encoding, new realMod.StringDecoder("utf-8").encoding);
  assert.equal(new ours.StringDecoder("ucs2").encoding, new realMod.StringDecoder("ucs2").encoding);
  assert.throws(() => new ours.StringDecoder("bogus"), /Unknown encoding/);
});

test("guest require resolves string_decoder as a builtin", async () => {
  const sys = fakeSys();
  const main = [
    "const { StringDecoder } = require('string_decoder');",
    "const fs = require('fs');",
    "const d = new StringDecoder('utf8');",
    "const out = d.write(Buffer.from([0xE2])) + d.end(Buffer.from([0x82, 0xAC]));",
    "fs.writeFileSync('/string-decoder-ok', out);",
  ].join("\n");
  await createNodeRuntime(sys)("/m.js", main);
  assert.equal(createFs(sys.syncFs).readFileSync("/string-decoder-ok", "utf8"), "€");
});
