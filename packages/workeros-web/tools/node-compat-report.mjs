// Generate a website-ready compatibility report from a completed full-tree run.
// Reads the raw per-file results and re-buckets them with the canonical
// classifier, emitting a compact JSON the site can fetch directly.
//
//   node tools/node-compat-report.mjs
//
// Input : .node-compat/v<VERSION>/full-results.json  (from test:node-compat:full)
// Output: .node-compat/v<VERSION>/report.json         (public, stable shape)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classify } from "./node-compat-classify.mjs";

const VERSION = "22.23.1";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const cache = `${root}/.node-compat/v${VERSION}`;

const raw = JSON.parse(await readFile(`${cache}/full-results.json`, "utf8"));

const emptyCounts = () => ({ total: 0, passed: 0, failed: 0, skipped: 0, timeouts: 0 });
const modules = new Map();
const suites = new Map();
const overall = emptyCounts();

for (const result of raw.results) {
  const { suite, module } = classify(result.file);
  const status = result.status; // pass | fail | timeout | skip
  for (const bucket of [overall, get(modules, module), get(suites, suite)]) {
    bucket.total++;
    if (status === "pass") bucket.passed++;
    else if (status === "skip") bucket.skipped++;
    else {
      bucket.failed++;
      if (status === "timeout") bucket.timeouts++;
    }
  }
}

function get(map, key) {
  if (!map.has(key)) map.set(key, emptyCounts());
  return map.get(key);
}

const withRate = ([name, c]) => ({
  name,
  ...c,
  passRate: c.total ? Math.round((c.passed / c.total) * 1000) / 10 : 0,
});

const moduleRows = [...modules].map(withRate).sort((a, b) => b.failed - a.failed || b.total - a.total);
const suiteRows = [...suites].map(withRate).sort((a, b) => b.total - a.total);

const report = {
  target: { runtime: "Node.js", version: VERSION, channel: "Jod LTS" },
  generatedAt: new Date().toISOString(),
  source: "test:node-compat:full",
  overall: withRate(["overall", overall]),
  topFailures: moduleRows.filter((m) => m.failed > 0).slice(0, 10),
  modules: moduleRows,
  suites: suiteRows,
};

await writeFile(`${cache}/report.json`, JSON.stringify(report, null, 2) + "\n");

console.log(`node-compat: report -> ${cache}/report.json`);
console.log(`  overall: ${overall.passed}/${overall.total} pass (${report.overall.passRate}%)`);
console.log(`  modules: ${moduleRows.length} (was ${Object.keys(raw.modules).length} before reclassification)`);
console.log("  top failure buckets:");
for (const m of report.topFailures) {
  console.log(`    ${m.name.padEnd(16)} ${String(m.failed).padStart(4)} fail / ${m.total} (${m.passRate}% pass)`);
}
