// Guard: every guest-runtime module that /bin/node imports at load time must be
// installed into /lib/workeros-node/ by the `libraries` manifest (src/index.js).
// If it isn't, the kernel resolver throws `NotFound("/lib/workeros-node/<x>.js")`
// at runtime (the failure mode that shipped node:net/http without registering
// them). This walks the relative `./x.js` imports of the installed runtime files
// and asserts the manifest covers each — a static check, no kernel needed.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (p) => readFileSync(join(srcDir, p), "utf8");

// The paths the manifest installs under /lib/workeros-node/ (basenames).
const manifestSrc = read("index.js");
const installed = new Set(
  [...manifestSrc.matchAll(/\/lib\/workeros-node\/([\w-]+\.js)/g)].map((m) => m[1]),
);

// Transitively collect every ./x.js a runtime module imports, starting from the
// entry points node-program.js loads from /lib/workeros-node/.
const roots = ["node/require-runtime.js", "node/esm-graph.js"];
const seen = new Set();
const queue = [...roots];
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const src = read(rel);
  for (const m of src.matchAll(/from\s+["']\.\/([\w-]+\.js)["']/g)) {
    queue.push("node/" + m[1]);
  }
}

test("every guest-runtime import is installed by the libraries manifest", () => {
  // Every reachable runtime module (roots + everything they import) must be
  // installed under /lib/workeros-node/, else the kernel resolver 404s at runtime.
  const needed = new Set([...seen].map((p) => p.split("/").pop()));
  const missing = [...needed].filter((b) => !installed.has(b));
  assert.deepEqual(missing, [], `missing from /lib/workeros-node manifest: ${missing.join(", ")}`);
});
