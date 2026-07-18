// Download the explicitly selected official Node.js compatibility tests.
// The cache is ignored; the committed case manifest pins the release and records
// which upstream files are runnable or blocked by known WorkerOS limitations.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const casesPath = fileURLToPath(new URL("./node-compat-cases.json", import.meta.url));
const cases = JSON.parse(await readFile(casesPath, "utf8"));
const tag = `v${cases.version}`;
const cache = join(root, ".node-compat", tag);
const fetched = [];
const exec = promisify(execFile);

for (const path of cases.runnable) {
  const url = `https://raw.githubusercontent.com/nodejs/node/${tag}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const source = await response.text();
  const destination = join(cache, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, source);
  fetched.push({
    path,
    source: url,
    sha256: createHash("sha256").update(source).digest("hex"),
  });
}

await writeFile(
  join(cache, "manifest.json"),
  JSON.stringify({ version: cases.version, fetched, blocked: cases.blocked }, null, 2) + "\n",
);
console.log(`node-compat: synced ${fetched.length} official ${tag} tests to ${cache}`);

// Prepare the complete upstream test tree for the raw Playwright runner. One tar
// transfer is substantially faster than thousands of VFS request round-trips.
const sourceArchive = join(cache, `node-${tag}-source.tar.gz`);
const sourceRoot = join(cache, "source");
const guestArchive = join(cache, "node-test-suite.tar");
const fileList = join(cache, "test-files.txt");
const metadataPath = join(cache, "test-metadata.json");
let haveFullCache = false;
try {
  haveFullCache = (await stat(guestArchive)).isFile() && (await stat(fileList)).isFile() &&
    (await stat(metadataPath)).isFile();
} catch {}

if (!haveFullCache) {
  const sourceUrl = `https://github.com/nodejs/node/archive/refs/tags/${tag}.tar.gz`;
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`${sourceUrl} -> HTTP ${response.status}`);
  await writeFile(sourceArchive, new Uint8Array(await response.arrayBuffer()));
  await mkdir(sourceRoot, { recursive: true });
  await exec("tar", [
    "-xzf", sourceArchive, "-C", sourceRoot, "--strip-components=1",
    `node-${cases.version}/test`,
  ]);
  await exec("tar", ["-cf", guestArchive, "-C", sourceRoot, "test"]);
  const testRoot = join(sourceRoot, "test");
  const entries = await readdir(testRoot, { recursive: true, withFileTypes: true });
  const tests = entries
    .filter((entry) => entry.isFile() && /^test-.*\.(?:js|mjs|cjs)$/.test(entry.name))
    .map((entry) => relative(testRoot, join(entry.parentPath, entry.name)))
    .filter((path) => path.split("/").length === 2)
    .sort();
  await writeFile(fileList, tests.join("\n") + "\n");
  const metadata = {};
  await Promise.all(tests.map(async (path) => {
    const source = await readFile(join(testRoot, path), "utf8");
    if (
      /\/\/\s*Flags:.*(?:--expose-internals|--allow-natives-syntax)/.test(source) ||
      /(?:require\s*\(|from\s+)["'](?:node:)?internal\//.test(source) ||
      /\binternalBinding\s*\(/.test(source)
    ) {
      metadata[path] = { skip: "native-internal" };
    }
  }));
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
  console.log(`node-compat: prepared full test tree (${tests.length} top-level files)`);
}
