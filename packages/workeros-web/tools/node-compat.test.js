// Runs a selected, pinned subset of the official Node.js test suite inside a
// booted WorkerOS instance. Upstream assertions remain unchanged; the only source
// adaptation removes `require('../common')`, Node's private harness bootstrap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDevServer } from "./serve.js";
import cases from "./node-compat-cases.json" with { type: "json" };

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tag = `v${cases.version}`;
const results = [];

async function runInWorkerOS(file, source) {
  const server = createDevServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/packages/workeros-web/tools/mvp.html`);
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });
    return await page.evaluate(async ({ file, source }) => {
      const os = await window.__wos.boot();
      const adapted = source
        .replace(/^require\(['"]\.\.\/common['"]\);\s*$/m, "")
        .replace(/^const common = require\(['"]\.\.\/common['"]\);\s*$/m, "const common = {};");
      await os.fs.write(`/compat/${file}`, adapted);
      const proc = await os.spawn(["node", `/compat/${file}`], { cwd: "/compat" });
      const decoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      proc.onStdout((bytes) => { stdout += decoder.decode(bytes, { stream: true }); });
      proc.onStderr((bytes) => { stderr += decoder.decode(bytes, { stream: true }); });
      return { code: await proc.exited, stdout, stderr };
    }, { file: file.split("/").pop(), source });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const file of cases.runnable) {
  test(`Node ${tag}: ${file}`, { skip: chromium ? false : "playwright not installed" }, async () => {
    const source = await readFile(`${repoRoot}/.node-compat/${tag}/${file}`, "utf8");
    const result = await runInWorkerOS(file, source);
    results.push({ file, status: result.code === 0 ? "pass" : "fail" });
    assert.equal(result.code, 0, result.stderr || result.stdout);
  });
}

test("Node compatibility summary", { skip: chromium ? false : "playwright not installed" }, () => {
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const skipped = cases.officialSuite.total - passed - failed;
  const notYetRunnable = skipped - cases.officialSuite.upstreamSkipped;
  console.log(
    `node-compat ${tag}: ${cases.officialSuite.total} total; ` +
    `${passed} passed, ${failed} failed, ${skipped} skipped ` +
    `(${cases.officialSuite.upstreamSkipped} upstream, ${notYetRunnable} WorkerOS not yet runnable)`,
  );
});
