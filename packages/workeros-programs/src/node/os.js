// `node:os` — operating-system info for the WorkerOS Node runtime.
//
// GUEST code (INV-1). WorkerOS is a single browser-hosted OS, so most of `os` is
// either a constant (posix, one VFS root) or a best-effort read of a real browser
// signal (`navigator.hardwareConcurrency`, `navigator.deviceMemory`). Honest
// surface (INV-5): where the browser can't tell us a true value we return a
// documented approximation rather than fabricate detail. Pure — no syscalls — so
// it is fully unit-testable on its own.

const GiB = 1024 * 1024 * 1024;
const env = () => (globalThis.process && globalThis.process.env) || {};
const nav = () => globalThis.navigator || {};

export function createOs() {
  const os = {
    EOL: "\n",
    devNull: "/dev/null",

    // Matches `process.platform` — a REAL Node platform ("linux"), so packages
    // that switch on it don't hit an "unsupported platform" hard error. WorkerOS
    // is Linux-personality; true identity lives in `type()` ("WorkerOS") and
    // `process.release.name`.
    platform: () => "linux",
    arch: () => "wasm32",
    machine: () => "wasm32",
    type: () => "WorkerOS",
    release: () => "0.0.0",
    version: () => "WorkerOS",
    endianness: () => "LE", // wasm is little-endian

    hostname: () => "workeros",
    tmpdir: () => env().TMPDIR || "/tmp",
    homedir: () => env().HOME || "/root",

    // Browser-derived approximations (INV-5): coarse but real signals.
    availableParallelism: () => nav().hardwareConcurrency || 1,
    cpus() {
      const n = nav().hardwareConcurrency || 1;
      return Array.from({ length: n }, () => ({
        model: "wasm",
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      }));
    },
    // `navigator.deviceMemory` is coarse (rounded to a power of two, capped at 8).
    totalmem: () => (nav().deviceMemory || 4) * GiB,
    // A browser can't report free memory; we return total (documented).
    freemem: () => os.totalmem(),
    uptime: () => Math.floor((globalThis.performance ? performance.now() : 0) / 1000),

    // No real load metric or NICs in a browser — honest empties (as on many
    // platforms `loadavg` is already all-zero off Linux).
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({}),

    userInfo: () => ({
      username: "root",
      uid: 0,
      gid: 0,
      shell: env().SHELL || "/bin/wsh",
      homedir: os.homedir(),
    }),

    getPriority: () => 0,
    setPriority: () => {},

    constants: {
      signals: {},
      errno: {},
      priority: {
        PRIORITY_LOW: 19,
        PRIORITY_BELOW_NORMAL: 10,
        PRIORITY_NORMAL: 0,
        PRIORITY_ABOVE_NORMAL: -7,
        PRIORITY_HIGH: -14,
        PRIORITY_HIGHEST: -20,
      },
    },
  };
  return os;
}
