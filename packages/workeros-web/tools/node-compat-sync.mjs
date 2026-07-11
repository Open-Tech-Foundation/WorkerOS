// Download the explicitly selected official Node.js compatibility tests.
// The cache is ignored; the committed case manifest pins the release and records
// which upstream files are runnable or blocked by known WorkerOS limitations.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const casesPath = fileURLToPath(new URL("./node-compat-cases.json", import.meta.url));
const cases = JSON.parse(await readFile(casesPath, "utf8"));
const tag = `v${cases.version}`;
const cache = join(root, ".node-compat", tag);
const fetched = [];

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
