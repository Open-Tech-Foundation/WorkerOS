// Build step (`npm run build:programs`): bundle each /sbin coreutil into a
// single self-contained ESM file. A coreutil's source is an inline string
// (`src/index.js` `coreutils`) whose only import is the shared CLI arg parser
// (`/lib/workeros-cli/args.js`). esbuild inlines it so the coreutil reaches the
// kernel as one module with **no imports** — the same "one flat artifact for
// dev, test, and prod" contract the /bin programs follow. There is no arg-parser
// clone in this package: the real implementation is authored once, in the
// sibling programs package, and pulled in here at build time.
//
// Output lands under `src/bundles/<name>.js`, right where `src/index.js`'s
// `bundledCoreutils` fetches it at boot.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { coreutils } from "../src/index.js";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const outDir = join(srcDir, "bundles");
// The shared arg parser: its single real implementation lives in the programs
// package (`src/cli/args.js`). Resolve the guest VFS specifier to it.
const argsFile = fileURLToPath(
  new URL("../../workeros-programs/src/cli/args.js", import.meta.url),
);

const guestLibPlugin = {
  name: "workeros-guest-lib",
  setup(b) {
    b.onResolve({ filter: /^\/lib\/workeros-cli\/args\.js$/ }, () => ({ path: argsFile }));
  },
};

await mkdir(outDir, { recursive: true });

let count = 0;
for (const [path, source] of Object.entries(coreutils)) {
  const name = path.split("/").pop();
  const result = await build({
    stdin: { contents: source, resolveDir: srcDir, loader: "js", sourcefile: `${name}.js` },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022", // top-level await + modern syntax the coreutils use
    minify: process.argv.includes("--minify"),
    legalComments: "none",
    logLevel: "warning",
    plugins: [guestLibPlugin],
  });
  await writeFile(join(outDir, `${name}.js`), result.outputFiles[0].text);
  count++;
}
console.log(`[bundle] built ${count} coreutil bundles → src/bundles/`);
