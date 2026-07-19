// Build step (`npm run build`): bundle the host runtime into a self-contained
// `dist/`. esbuild resolves the by-name imports of `@opentf/workeros-programs`
// and `@opentf/workeros-coreutils` (their self-contained dist) and inlines them,
// so the published `@opentf/workeros-web` carries the whole OS — a consumer
// imports `{ boot }` by name and its bundler ships one artifact. No `../../`
// sibling paths, no raw source serving.
//
// Three entry points become three output files (no code-splitting, so each is
// fully standalone):
//   • index.js          — the main-thread client API (`boot`, `WorkerOS`, …).
//   • kernel-worker.js   — launched by client.js via `new Worker(new URL(...))`.
//   • program-worker.js  — launched by kernel-worker.js the same way.
// entryNames=[name] keeps those basenames so the `new URL("./x.js", ...)` worker
// references resolve to their sibling output. The kernel wasm is emitted as an
// asset under kernel-wasm/ and its `new URL(...)` references rewritten.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cp, rm, access } from "node:fs/promises";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const distDir = fileURLToPath(new URL("../dist", import.meta.url));
const wasmSrc = `${srcDir}/kernel-wasm`;

await access(`${wasmSrc}/workeros_web_wasm_bg.wasm`).catch(() => {
  throw new Error(
    "kernel wasm missing — run `npm run build:wasm` first (needs cargo + wasm-pack).",
  );
});

await rm(distDir, { recursive: true, force: true });

await build({
  entryPoints: [
    `${srcDir}/index.js`,
    `${srcDir}/kernel-worker.js`,
    `${srcDir}/program-worker.js`,
  ],
  outdir: distDir,
  entryNames: "[name]",
  assetNames: "kernel-wasm/[name]",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  splitting: false,
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});

// The kernel wasm binary rides alongside as an asset. client.js resolves it with
// `new URL("./kernel-wasm/workeros_web_wasm_bg.wasm", import.meta.url)` and hands
// the URL to the worker, so it must sit at dist/kernel-wasm/. A consumer bundler
// (Vite) sees that same static `new URL` and emits it from here. The wasm-bindgen
// glue JS is already inlined into kernel-worker.js by esbuild.
await cp(`${wasmSrc}/workeros_web_wasm_bg.wasm`, `${distDir}/kernel-wasm/workeros_web_wasm_bg.wasm`);

// The OS-program wasm (grep, coreutils, codec, node-bundler, npm.tgz) is referenced
// by the inlined @opentf/workeros-programs manifest as `new URL("./assets/<x>",
// import.meta.url)` — relative to kernel-worker.js. Co-locate the programs package's
// assets under dist/assets/ so those references resolve (standalone) and a consumer
// bundler emits them (Vite; otfw once it recurses into worker chunks).
const programsAssets = join(
  dirname(fileURLToPath(import.meta.resolve("@opentf/workeros-programs"))),
  "assets",
);
await cp(programsAssets, `${distDir}/assets`, { recursive: true });

console.log("[build-dist] bundled host runtime → dist/ (index, kernel-worker, program-worker + kernel-wasm + program assets)");
