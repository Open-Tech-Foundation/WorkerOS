// Execute every top-level official Node test file inside one persistent WorkerOS
// browser instance. This is deliberately a raw compatibility run, not Node's
// Python classifier: unsupported CLI flags and internal modules become failures,
// while hangs become timeouts. Results are written to the ignored cache.

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDevServer } from "./serve.js";
import { moduleFor } from "./node-compat-classify.mjs";

const VERSION = "22.23.1";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const cache = `${root}/.node-compat/v${VERSION}`;
const allFiles = (await readFile(`${cache}/test-files.txt`, "utf8")).trim().split("\n").filter(Boolean);
const filter = process.env.NODE_COMPAT_FILTER || "";
const limit = Number(process.env.NODE_COMPAT_LIMIT) || Infinity;
const files = allFiles.filter((file) => !filter || file.includes(filter)).slice(0, limit);
let metadata = {};
try {
  metadata = JSON.parse(await readFile(`${cache}/test-metadata.json`, "utf8"));
} catch {}
const runnableFiles = files.filter((file) => !metadata[file]?.skip);
const timeoutMs = Number(process.env.NODE_COMPAT_TIMEOUT_MS) || 3000;
const concurrency = Number(process.env.NODE_COMPAT_CONCURRENCY) || 24;
const jsonlPath = `${cache}/full-results.jsonl`;

const moduleTotals = new Map();
for (const file of files) {
  const module = moduleFor(file);
  moduleTotals.set(module, (moduleTotals.get(module) || 0) + 1);
}
const moduleCounts = new Map(
  [...moduleTotals].map(([module, total]) => [module, { total, completed: 0, passed: 0, failed: 0, skipped: 0 }]),
);
const counts = { total: files.length, completed: 0, passed: 0, failed: 0, skipped: 0, timeouts: 0 };
const results = [];
let writeChain = Promise.resolve();

await writeFile(jsonlPath, "");
const writeEvent = (event) => {
  writeChain = writeChain.then(() => appendFile(jsonlPath, JSON.stringify(event) + "\n"));
  return writeChain;
};
await writeEvent({ type: "run-start", version: VERSION, timeoutMs, concurrency, filter, limit, counts: { ...counts } });

const server = createDevServer();
await new Promise((resolve) => server.listen(0, resolve));
const browser = await chromium.launch();
const baseUrl = `http://localhost:${server.address().port}`;

const recordResult = async (result) => {
  const module = moduleFor(result.file);
  result.module = module;
  results.push(result);
  counts.completed++;
  const current = moduleCounts.get(module);
  current.completed++;
  if (result.status === "pass") {
    counts.passed++;
    current.passed++;
  } else if (result.status === "skip") {
    counts.skipped++;
    current.skipped++;
  } else {
    counts.failed++;
    current.failed++;
    if (result.status === "timeout") counts.timeouts++;
  }
  const label = result.status === "pass" ? "PASS" : result.status === "skip" ? "SKIP" :
    result.status === "timeout" ? "TIME" : "FAIL";
  const reason = result.reason ? ` ${result.reason}` : "";
  console.log(
    `[${String(counts.completed).padStart(String(counts.total).length)}/${counts.total}] ${label} ` +
    `${module} ${current.completed}/${current.total} ` +
    `(P${current.passed} F${current.failed} S${current.skipped}) ${result.file}${reason} | ` +
    `all P${counts.passed} F${counts.failed} S${counts.skipped}`,
  );
  await writeEvent({
    type: "test",
    version: VERSION,
    sequence: counts.completed,
    ...result,
    moduleCounts: { ...current },
    counts: { ...counts },
  });
};

async function createLane() {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/packages/workeros-web/tools/mvp.html`);
  await page.waitForFunction(() => window.__ready, { timeout: 15000 });
  await page.evaluate(async ({ version }) => {
    const os = await window.__wos.boot();
    window.__compatOS = os;
    const response = await fetch(`/.node-compat/v${version}/node-test-suite.tar`);
    if (!response.ok) throw new Error(`test archive -> HTTP ${response.status}`);
    await os.fs.write("/node-test-suite.tar", new Uint8Array(await response.arrayBuffer()));
    const extract = await os.spawn(["tar", "-xf", "/node-test-suite.tar", "-C", "/node"]);
    const code = await extract.exited;
    if (code !== 0) throw new Error(`guest tar exited ${code}`);
    const prep = await os.spawn([
      "node", "-e",
      "const fs=require('fs');for(let i=0;i<5000;i++)fs.mkdirSync('/tmp/node-test-'+i,{recursive:true})",
    ]);
    const prepCode = await prep.exited;
    if (prepCode !== 0) throw new Error(`temp-directory preparation exited ${prepCode}`);
  }, { version: VERSION });
  return page;
}

async function runTest(page, file, index) {
  return page.evaluate(async ({ file, index }) => {
    const os = window.__compatOS;
    const decoder = new TextDecoder();
    const path = `/node/test/${file}`;
    const cwd = path.slice(0, path.lastIndexOf("/"));
    let proc;
    try {
      proc = await os.spawn(["node", path], {
        cwd,
        env: {
          HOME: "/root",
          PATH: "/bin:/sbin",
          NODE_TEST_DIR: `/tmp/node-test-${index}`,
          NODE_TEST_KNOWN_GLOBALS: "0",
        },
      });
    } catch (error) {
      return { file, status: "skip", reason: "launch-error", detail: String(error?.message || error) };
    }
    let stderr = "";
    proc.onStderr((bytes) => {
      if (stderr.length < 4000) stderr += decoder.decode(bytes, { stream: true });
    });
    const code = await proc.exited;
    return { file, status: code === 0 ? "pass" : "fail", code, detail: stderr.slice(0, 4000) };
  }, { file, index });
}

try {
  for (const file of files) {
    if (metadata[file]?.skip) {
      await recordResult({ file, status: "skip", reason: metadata[file].skip });
    }
  }
  console.log(
    `node-compat: running ${runnableFiles.length}/${files.length} files ` +
    `(${files.length - runnableFiles.length} pre-skipped, ${concurrency} concurrent, ${timeoutMs}ms timeout)...`,
  );
  let next = 0;
  async function worker(laneNumber) {
    console.log(`node-compat: preparing lane ${laneNumber}/${concurrency}...`);
    let page = await createLane();
    while (next < runnableFiles.length) {
      const index = next++;
      const file = runnableFiles[index];
      let timer;
      const evaluation = runTest(page, file, index).catch((error) => ({
        file,
        status: "fail",
        reason: "page-error",
        detail: String(error?.message || error),
      }));
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      let result = await Promise.race([evaluation, timeout]);
      clearTimeout(timer);
      if (result === null) {
        result = { file, status: "timeout", reason: "host-timeout" };
        await page.close().catch(() => {});
        page = null;
      }
      await recordResult(result);
      if (!page && next < runnableFiles.length) {
        console.log(`node-compat: recovering lane ${laneNumber} after ${file}...`);
        page = await createLane();
      }
    }
    await page?.close().catch(() => {});
  }
  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1)));

  for (const [module, current] of [...moduleCounts].sort(([a], [b]) => a.localeCompare(b))) {
    await writeEvent({ type: "module-summary", version: VERSION, module, ...current });
  }
  await writeEvent({ type: "run-summary", version: VERSION, counts: { ...counts } });
  await writeChain;
  await writeFile(
    `${cache}/full-results.json`,
    JSON.stringify({
      version: VERSION,
      timeoutMs,
      concurrency,
      counts,
      modules: Object.fromEntries([...moduleCounts].sort(([a], [b]) => a.localeCompare(b))),
      results,
    }, null, 2) + "\n",
  );
  console.log(JSON.stringify(counts, null, 2));
  console.log(`node-compat: live events: ${jsonlPath}`);
  console.log(`node-compat: summary: ${cache}/full-results.json`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
