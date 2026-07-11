// Execute every top-level official Node test file inside one persistent WorkerOS
// browser instance. This is deliberately a raw compatibility run, not Node's
// Python classifier: unsupported CLI flags and internal modules become failures,
// while hangs become timeouts. Results are written to the ignored cache.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDevServer } from "./serve.js";

const VERSION = "22.23.1";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const cache = `${root}/.node-compat/v${VERSION}`;
const files = (await readFile(`${cache}/test-files.txt`, "utf8")).trim().split("\n").filter(Boolean);
const timeoutMs = Number(process.env.NODE_COMPAT_TIMEOUT_MS) || 3000;
const concurrency = Number(process.env.NODE_COMPAT_CONCURRENCY) || 24;

const server = createDevServer();
await new Promise((resolve) => server.listen(0, resolve));
const browser = await chromium.launch();
const page = await browser.newPage();

try {
  await page.goto(`http://localhost:${server.address().port}/packages/workeros-web/tools/mvp.html`);
  await page.waitForFunction(() => window.__ready, { timeout: 15000 });

  console.log(`node-compat: importing official Node v${VERSION} test tree into WorkerOS...`);
  await page.evaluate(async ({ version }) => {
    const os = await window.__wos.boot();
    window.__compatOS = os;
    const response = await fetch(`/.node-compat/v${version}/node-test-suite.tar`);
    if (!response.ok) throw new Error(`test archive -> HTTP ${response.status}`);
    await os.fs.write("/node-test-suite.tar", new Uint8Array(await response.arrayBuffer()));
    const extract = await os.spawn(["tar", "-xf", "/node-test-suite.tar", "-C", "/node"]);
    const code = await extract.exited;
    if (code !== 0) throw new Error(`guest tar exited ${code}`);
  }, { version: VERSION });

  console.log(`node-compat: running ${files.length} files (${concurrency} concurrent, ${timeoutMs}ms timeout)...`);
  const results = await page.evaluate(async ({ files, timeoutMs, concurrency }) => {
    const os = window.__compatOS;
    const decoder = new TextDecoder();
    let next = 0;
    const out = new Array(files.length);

    async function run(index) {
      const rel = files[index];
      const path = `/node/test/${rel}`;
      const cwd = path.slice(0, path.lastIndexOf("/"));
      let proc;
      try {
        proc = await os.spawn(["node", path], {
          cwd,
          env: {
            HOME: "/root",
            PATH: "/bin:/sbin",
            NODE_TEST_DIR: `/tmp/node-test-${index}`,
          },
        });
      } catch (error) {
        return { file: rel, status: "launch-error", detail: String(error?.message || error) };
      }
      let stderr = "";
      proc.onStderr((bytes) => {
        if (stderr.length < 4000) stderr += decoder.decode(bytes, { stream: true });
      });
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const result = await Promise.race([proc.exited, timeout]);
      if (result === "timeout") {
        proc.kill(9);
        return { file: rel, status: "timeout", detail: stderr.slice(0, 4000) };
      }
      clearTimeout(timer);
      return {
        file: rel,
        status: result === 0 ? "pass" : "fail",
        code: result,
        detail: stderr.slice(0, 4000),
      };
    }

    async function worker() {
      for (;;) {
        const index = next++;
        if (index >= files.length) return;
        out[index] = await run(index);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return out;
  }, { files, timeoutMs, concurrency });

  const counts = { total: results.length, pass: 0, fail: 0, timeout: 0, launchError: 0 };
  for (const result of results) {
    if (result.status === "pass") counts.pass++;
    else if (result.status === "fail") counts.fail++;
    else if (result.status === "timeout") counts.timeout++;
    else counts.launchError++;
  }
  await writeFile(
    `${cache}/full-results.json`,
    JSON.stringify({ version: VERSION, timeoutMs, concurrency, counts, results }, null, 2) + "\n",
  );
  console.log(JSON.stringify(counts, null, 2));
  console.log(`node-compat: detailed results: ${cache}/full-results.json`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
