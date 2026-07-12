// Copies the WorkerOS host runtime into the site's `public/` tree so the
// playground can boot the real kernel from a same-origin URL.
//
// The runtime is authored across several packages whose worker files import each
// other with *relative* paths (e.g. program-worker.js → `../../workeros-programs/
// src/node/process-shim.js`). To keep those imports resolving, we mirror the
// original `packages/<pkg>/src/...` layout verbatim under `public/workeros/`.
//
// This runs before `otfw dev` / `otfw build` (see package.json scripts), so the
// playground always serves the current kernel — including the wasm-pack output in
// workeros-web/src/kernel-wasm/. Run `npm run build:wasm` in packages/workeros-web
// first if that directory is missing.

import { cp, rm, mkdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(siteRoot, "..");
const dest = join(siteRoot, "public", "workeros", "packages");

// The three packages that make up the bootable runtime. Order is cosmetic.
const packages = ["workeros-web", "workeros-coreutils", "workeros-programs"];

// Packages whose `/bin` and `/sbin` programs are esbuild-bundled into
// `src/bundles/` (gitignored). We build them here — pure JS, esbuild is each
// package's own devDep, no Rust toolchain — so a plain `npm run dev`/`build`
// always serves current, self-contained program sources. (The kernel wasm is the
// exception: it needs cargo, so we require it pre-built rather than build it.)
const bundledPackages = ["workeros-programs", "workeros-coreutils"];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const wasmDir = join(repoRoot, "packages", "workeros-web", "src", "kernel-wasm");
  if (!(await exists(wasmDir))) {
    console.error(
      "\n✗ WorkerOS kernel wasm not found at packages/workeros-web/src/kernel-wasm/.\n" +
        "  Build it first:\n" +
        "    cd packages/workeros-web && npm install && npm run build:wasm\n",
    );
    process.exit(1);
  }

  // Build the program bundles into each package's src/bundles/ before copying,
  // so the mirrored tree carries current, self-contained /bin + /sbin programs.
  for (const pkg of bundledPackages) {
    const bundler = join(repoRoot, "packages", pkg, "tools", "bundle.mjs");
    execFileSync(process.execPath, [bundler], { stdio: "inherit" });
  }

  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  for (const pkg of packages) {
    const from = join(repoRoot, "packages", pkg, "src");
    const to = join(dest, pkg, "src");
    if (!(await exists(from))) {
      console.error(`✗ missing package source: ${from}`);
      process.exit(1);
    }
    await cp(from, to, { recursive: true });
    console.log(`  synced ${pkg}/src → public/workeros/packages/${pkg}/src`);
  }
  console.log("✓ WorkerOS runtime synced into public/workeros");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
