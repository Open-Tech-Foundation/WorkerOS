// Build step (`npm run build:vendor-npm`): vendor the real npm CLI into the OS
// image. npm is a third-party program we don't author here — like a distro
// shipping /usr/lib/node_modules/npm — so we pull its published, self-contained
// tarball (bundledDependencies included) from the registry and drop it in the
// source tree as a single compressed asset.
//
// The asset ships (ephemerally) at `/lib/workeros-npm/npm.tgz`; `/bin/npm`
// (npm-launcher.js) unpacks it once into the persistent `/usr/lib/npm` on first
// use and then execs `node /usr/lib/npm/bin/npm-cli.js`. Nothing kernel-side
// changes — npm stays a userland program that only places files (INV-1).
//
// Pinned for reproducibility; bump NPM_VERSION to upgrade (the launcher notices
// the new asset and re-unpacks).
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const NPM_VERSION = "11.9.0";

const outDir = fileURLToPath(new URL("../src/vendor", import.meta.url));
const url = `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`;

await mkdir(outDir, { recursive: true });
const res = await fetch(url);
if (!res.ok) throw new Error(`vendor-npm: ${url} -> HTTP ${res.status}`);
const bytes = new Uint8Array(await res.arrayBuffer());
await writeFile(join(outDir, "npm.tgz"), bytes);
console.log(`[vendor-npm] npm@${NPM_VERSION} → src/vendor/npm.tgz (${(bytes.length / 1e6).toFixed(1)} MB)`);
