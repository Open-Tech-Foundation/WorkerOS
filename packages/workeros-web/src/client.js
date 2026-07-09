// The main-thread client API for WorkerOS.
//
// Phase 0 surface: `boot()` spins up the kernel worker and round-trips the
// version handshake. Later phases grow this into `fs.write`, `spawn`,
// `onStdout`, `onExit` (Phase 2) — all still thin calls that defer every
// decision to the Rust kernel.

import { MSG } from "./protocol.js";

/**
 * Boot a WorkerOS instance.
 *
 * @param {object} [opts]
 * @param {string} [opts.workerUrl] URL of kernel-worker.js (defaults to the
 *   sibling module resolved against this file).
 * @param {string} [opts.wasmUrl] URL of the kernel .wasm binary.
 * @returns {Promise<WorkerOS>}
 */
export function boot(opts = {}) {
  const workerUrl =
    opts.workerUrl || new URL("./kernel-worker.js", import.meta.url).href;
  const wasmUrl =
    opts.wasmUrl ||
    new URL("./kernel-wasm/workeros_web_wasm_bg.wasm", import.meta.url).href;

  const worker = new Worker(workerUrl, { type: "module" });

  return new Promise((resolve, reject) => {
    const onFirst = (ev) => {
      const msg = ev.data;
      if (msg.type === MSG.BOOTED) {
        worker.removeEventListener("message", onFirst);
        resolve(new WorkerOS(worker, { version: msg.version, abi: msg.abi }));
      } else if (msg.type === MSG.ERROR) {
        worker.removeEventListener("message", onFirst);
        worker.terminate();
        reject(new Error(`kernel boot failed: ${msg.error}`));
      }
    };
    worker.addEventListener("message", onFirst);
    worker.addEventListener("error", (e) =>
      reject(new Error(`kernel worker error: ${e.message}`)),
    );
    worker.postMessage({ type: MSG.BOOT, wasmUrl });
  });
}

/** A booted WorkerOS instance handle. */
export class WorkerOS {
  constructor(worker, handshake) {
    this._worker = worker;
    /** @type {string} kernel version reported by the boot handshake */
    this.version = handshake.version;
    /** @type {string} ABI the kernel implements */
    this.abi = handshake.abi;
  }

  /** Tear down the instance (terminates the kernel worker). */
  shutdown() {
    this._worker.terminate();
  }
}
