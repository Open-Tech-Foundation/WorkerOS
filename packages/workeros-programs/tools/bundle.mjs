// Build step (`npm run build:programs`): bundle each `/bin` js program into a
// single self-contained ESM file. esbuild inlines every `/lib/workeros-*/…` and
// relative import, so the program reaches the kernel as one module with **no
// imports** — the kernel's import scanner then has nothing to resolve, and dev,
// tests, and production all boot the exact same artifact.
//
// Output mirrors the source tree under `src/bundles/` (e.g.
// `src/node/node-program.js` → `src/bundles/node/node-program.js`), right where
// `src/index.js`'s `bundledText()` fetches it at boot. Sourcemaps are emitted so
// a crashing program still yields a readable stack into its real source.
//
// Pass `--watch` to rebuild on change (used by the dev server); `--minify` for a
// smaller production image (off by default — readability wins for an OS you debug
// in the browser).
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { programs } from "../src/index.js";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const outDir = join(srcDir, "bundles");

// Guest VFS lib specifiers (`/lib/workeros-<seg>/<rest>`) map to their source
// files by the same convention `src/index.js` installs them under (see
// `libraries`): `/lib/workeros-cli/args.js` → `src/cli/args.js`.
const guestLibPlugin = {
  name: "workeros-guest-lib",
  setup(b) {
    b.onResolve({ filter: /^\/lib\/workeros-/ }, (args) => ({
      path: join(srcDir, args.path.slice("/lib/workeros-".length)),
    }));
  },
};

// Unique js entries (gzip serves gunzip/zcat; sh serves bash — one source each).
const entries = [...new Set(programs.filter((p) => p.type === "js" && p.entry).map((p) => p.entry))];

const opts = {
  entryPoints: entries.map((e) => join(srcDir, e)),
  outdir: outDir,
  outbase: srcDir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022", // top-level await + modern syntax the guests use
  sourcemap: true,
  minify: process.argv.includes("--minify"),
  legalComments: "none",
  logLevel: "info",
  plugins: [guestLibPlugin],
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log(`[bundle] watching ${entries.length} program sources → src/bundles/`);
} else {
  await build(opts);
  console.log(`[bundle] built ${entries.length} program bundles → src/bundles/`);
}
