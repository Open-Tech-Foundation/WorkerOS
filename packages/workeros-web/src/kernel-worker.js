// The kernel worker. Exactly one of these runs per WorkerOS instance. It loads
// the Rust→wasm kernel, boots it, and (Phase 0) answers the boot handshake.
//
// It never executes guest code — that is the program worker's job (Phase 2).
// This file is deliberately thin glue: all authority lives in the wasm kernel.

import init, { WebKernel } from "./kernel-wasm/workeros_web_wasm.js";
import { MSG } from "./protocol.js";

let kernel = null;

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case MSG.BOOT: {
        // `wasmUrl` lets the main thread point us at the .wasm binary so this
        // worker file stays location-independent.
        await init({ module_or_path: msg.wasmUrl });
        kernel = WebKernel.boot();
        self.postMessage({
          type: MSG.BOOTED,
          version: kernel.version,
          abi: kernel.abi,
        });
        break;
      }
      default:
        self.postMessage({
          type: MSG.ERROR,
          error: `unknown message type: ${msg.type}`,
        });
    }
  } catch (err) {
    self.postMessage({ type: MSG.ERROR, error: String(err && err.stack ? err.stack : err) });
  }
};
