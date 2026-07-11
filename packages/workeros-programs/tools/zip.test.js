// Tests for the pure ZIP lib. Self round-trip always runs; the strong checks
// shell out to the real Info-ZIP `zip`/`unzip` (skipped when absent) to prove
// interop in both directions — including DEFLATE payloads and CRC-32.
import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "../src/node/buffer.js";
import { zlib } from "../src/node/zlib.js";
import { createZip as _createZip, parseZip as _parseZip } from "../src/archive/zip.js";

globalThis.Buffer = Buffer;
// The lib takes the zlib codec by injection (no cross-tree import); bind it once.
const createZip = (entries) => _createZip(entries, zlib);
const parseZip = (bytes) => _parseZip(bytes, zlib);
const has = (cmd) => { try { execFileSync(cmd, ["-v"], { stdio: "ignore" }); return true; } catch { return false; } };
const hasZip = has("zip");
const hasUnzip = has("unzip");
const bytes = (s) => new TextEncoder().encode(s);
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

const SAMPLE = [
  { name: "notes/todo.txt", type: "file", data: bytes("buy milk\n"), mtime: 1_600_000_000_000 },
  { name: "big.txt", type: "file", data: bytes("compress me please. ".repeat(500)), mtime: 1_600_000_000_000 },
  { name: "empty.bin", type: "file", data: new Uint8Array(0), mtime: 1_600_000_000_000 },
];

test("self round-trip preserves names and bytes; large input compresses", () => {
  const archive = createZip(SAMPLE);
  const parsed = parseZip(archive);
  assert.equal(parsed.length, 3);
  assert.ok(eq(parsed.find((e) => e.name === "notes/todo.txt").data, bytes("buy milk\n")));
  assert.ok(eq(parsed.find((e) => e.name === "big.txt").data, bytes("compress me please. ".repeat(500))));
  // The repetitive member must have been DEFLATE'd, so the archive is far smaller.
  assert.ok(archive.length < 500 * 20 / 2);
});

test("real unzip extracts our archive", { skip: !hasUnzip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wzip-"));
  try {
    writeFileSync(join(dir, "a.zip"), createZip(SAMPLE));
    const listed = execFileSync("unzip", ["-l", join(dir, "a.zip")], { encoding: "utf8" });
    assert.match(listed, /notes\/todo\.txt/);
    execFileSync("unzip", ["-o", join(dir, "a.zip"), "-d", join(dir, "out")], { stdio: "ignore" });
    assert.equal(readFileSync(join(dir, "out/notes/todo.txt"), "utf8"), "buy milk\n");
    assert.equal(readFileSync(join(dir, "out/big.txt"), "utf8"), "compress me please. ".repeat(500));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("we parse an archive written by real zip", { skip: !hasZip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wzip-"));
  try {
    mkdirSync(join(dir, "proj"));
    writeFileSync(join(dir, "proj/a.txt"), "alpha\n");
    writeFileSync(join(dir, "proj/b.txt"), "beta beta beta\n".repeat(100));
    execFileSync("zip", ["-r", "-q", join(dir, "real.zip"), "proj"], { cwd: dir });
    const parsed = parseZip(new Uint8Array(readFileSync(join(dir, "real.zip"))));
    const a = parsed.find((e) => e.name === "proj/a.txt");
    const b = parsed.find((e) => e.name === "proj/b.txt");
    assert.ok(a && eq(a.data, bytes("alpha\n")));
    assert.ok(b && eq(b.data, bytes("beta beta beta\n".repeat(100))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseZip rejects a corrupt payload via CRC", () => {
  const archive = createZip([{ name: "x.txt", type: "file", data: bytes("hello".repeat(50)) }]);
  // Flip a byte inside the compressed data (just after the 30-byte local header + 5-char name).
  archive[40] ^= 0xff;
  assert.throws(() => parseZip(archive), /CRC mismatch|invalid|corrupt/i);
});
