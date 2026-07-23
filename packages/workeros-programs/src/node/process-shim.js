// workeros-programs/node — the minimal `process` global (Phase 2, PLAN.md).
//
// This is the GUEST tenant layer (INV-1/ADR-007): it maps Node's `process`
// semantics onto the kernel's WASI-shaped primitives. It knows nothing about how
// bytes reach the kernel — the host hands it `write`/`exit` callbacks that funnel
// through the syscall transport. Phase 5 grows this toward a fuller Node surface;
// today it is just argv / env / stdout / stderr / exit — "just enough `process`
// for ordinary scripts."

const encoder = new TextEncoder();

/**
 * Build the minimal Node `process` object.
 *
 * @param {object} io
 * @param {string[]} io.argv        full argv (e.g. ["node", "main.js", ...])
 * @param {Record<string,string>} io.env
 * @param {string}  io.cwd
 * @param {(fd: number, bytes: Uint8Array) => void} io.write  routes to fd_write
 * @param {(code: number) => void} io.exit                    routes to proc_exit
 */
export function createProcess({ argv, env, cwd, write, exit }) {
  const toBytes = (chunk) =>
    typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk);

  const makeStream = (fd) => ({
    write(chunk) {
      write(fd, toBytes(chunk));
      return true;
    },
  });

  return {
    // Node convention: argv[0] is the runtime, argv[1] the script.
    argv: ["node", ...argv.slice(1)],
    env: { ...env },
    platform: "workeros",
    // A truthful, non-Node-fidelity version tag (INV-5): we are not Node.
    version: "workeros-node/0.0.0",
    cwd() {
      return cwd;
    },
    stdout: makeStream(1),
    stderr: makeStream(2),
    exit(code = 0) {
      exit(code | 0);
      // Node's process.exit does not return; stop the current tick.
      throw new ProcessExit(code | 0);
    },
  };
}

/** Thrown by `process.exit()` to unwind the guest; the shim swallows it. */
export class ProcessExit extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.name = "ProcessExit";
    this.code = code;
  }
}
