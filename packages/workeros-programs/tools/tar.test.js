// Tests for the pure tar framing lib. Self round-trip always runs; the strong
// checks shell out to the real GNU `tar` (skipped where it isn't installed) so
// our writer/reader is proven interoperable with the actual tool in both
// directions.
import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTar, parseTar } from "../src/archive/tar.js";

const hasTar = (() => { try { execFileSync("tar", ["--version"]); return true; } catch { return false; } })();
const bytes = (s) => new TextEncoder().encode(s);
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

const SAMPLE = [
  { name: "dir", type: "dir", mtime: 1_600_000_000_000 },
  { name: "dir/hello.txt", type: "file", data: bytes("hello world\n"), mtime: 1_600_000_000_000 },
  { name: "readme.md", type: "file", data: bytes("# Title\n".repeat(300)), mtime: 1_600_000_000_000 },
  { name: "empty.txt", type: "file", data: new Uint8Array(0), mtime: 1_600_000_000_000 },
];

test("self round-trip preserves names, types, and bytes", () => {
  const parsed = parseTar(createTar(SAMPLE));
  const files = parsed.filter((e) => e.type === "file");
  assert.equal(files.length, 3);
  const hello = files.find((e) => e.name === "dir/hello.txt");
  assert.ok(eq(hello.data, bytes("hello world\n")));
  assert.ok(parsed.some((e) => e.name === "dir" && e.type === "dir"));
});

test("a long path uses the ustar prefix field", () => {
  const long = "a/very/deeply/nested/set/of/directories/that/exceeds/one/hundred/characters/in/total/length/file.txt";
  const parsed = parseTar(createTar([{ name: long, type: "file", data: bytes("x") }]));
  assert.equal(parsed[0].name, long);
});

test("real tar extracts our archive", { skip: !hasTar }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wtar-"));
  try {
    writeFileSync(join(dir, "a.tar"), createTar(SAMPLE));
    const listed = execFileSync("tar", ["-tf", join(dir, "a.tar")], { encoding: "utf8" });
    assert.match(listed, /dir\/hello\.txt/);
    execFileSync("tar", ["-xf", join(dir, "a.tar"), "-C", dir]);
    assert.equal(readFileSync(join(dir, "dir/hello.txt"), "utf8"), "hello world\n");
    assert.equal(readFileSync(join(dir, "readme.md"), "utf8"), "# Title\n".repeat(300));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("we parse an archive written by real tar", { skip: !hasTar }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wtar-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/one.txt"), "one\n");
    writeFileSync(join(dir, "src/two.txt"), "two two\n");
    execFileSync("tar", ["-cf", join(dir, "b.tar"), "-C", dir, "src"]);
    const parsed = parseTar(new Uint8Array(readFileSync(join(dir, "b.tar"))));
    const one = parsed.find((e) => e.name === "src/one.txt");
    const two = parsed.find((e) => e.name === "src/two.txt");
    assert.ok(one && eq(one.data, bytes("one\n")));
    assert.ok(two && eq(two.data, bytes("two two\n")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
