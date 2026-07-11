// Test preload (`node --import`): the guest codec (crates/workeros-codec) is the
// sole zlib/crypto implementation, but `node --test` has no kernel/`sys` channel
// to load it through. So here — in plain Node, where `node:fs` is available — we
// read the built wasm, instantiate it, and inject it via `setCodec`, exactly as
// the program worker does at runtime. Every test file then exercises the real
// codec. Requires `npm run build:codec` first (the `pretest` script runs it).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { codecFromExports, setCodec } from "../src/node/wasm-codec.js";

const wasmPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "codec", "codec.wasm");
if (!existsSync(wasmPath)) {
  throw new Error(
    "codec.wasm not built — run `npm run build:codec` (from packages/workeros-web) before the tests.\n" +
      `Expected at: ${wasmPath}`,
  );
}
const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(readFileSync(wasmPath))), {});
setCodec(codecFromExports(instance.exports));
