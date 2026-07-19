// Unit test for the WASI host's terminal reporting — pure JS, no browser.
//
// wasi-libc's isatty(fd) is true iff the fd is a CHARACTER_DEVICE *and* carries
// neither the FD_SEEK nor FD_TELL right (a terminal is not seekable). We assert
// fd_fdstat_get reports exactly that for stdio (0/1/2) and, for contrast, leaves a
// regular file fully seekable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWasiImports } from "@opentf/workeros-programs/wasi";

const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_REGULAR_FILE = 4;
const RIGHTS_FD_SEEK = 1n << 2n;
const RIGHTS_FD_TELL = 1n << 5n;

function makeHost() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const { wasi_snapshot_preview1: wasi } = createWasiImports({
    sys: { write() {}, exit() {} },
    syncCall: () => ({ status: 0, value: {} }),
    argv: ["prog"],
    env: {},
    getMemory: () => memory,
  });
  return { wasi, dv: new DataView(memory.buffer) };
}

// fd_fdstat_get layout: filetype @0 (u8), fs_rights_base @8 (u64 LE).
function fdstat(wasi, dv, fd) {
  const ptr = 256;
  wasi.fd_fdstat_get(fd, ptr);
  return { filetype: dv.getUint8(ptr), rights: dv.getBigUint64(ptr + 8, true) };
}

test("stdio fds are non-seekable character devices (isatty → true)", () => {
  const { wasi, dv } = makeHost();
  for (const fd of [0, 1, 2]) {
    const { filetype, rights } = fdstat(wasi, dv, fd);
    assert.equal(filetype, FILETYPE_CHARACTER_DEVICE, `fd ${fd} is a character device`);
    assert.equal(rights & RIGHTS_FD_SEEK, 0n, `fd ${fd} has no FD_SEEK right`);
    assert.equal(rights & RIGHTS_FD_TELL, 0n, `fd ${fd} has no FD_TELL right`);
  }
});

test("a regular file keeps seek/tell rights (isatty → false)", () => {
  const { wasi, dv } = makeHost();
  const { filetype, rights } = fdstat(wasi, dv, 7); // any fd ≥ 4 that isn't the preopen
  assert.equal(filetype, FILETYPE_REGULAR_FILE);
  assert.notEqual(rights & RIGHTS_FD_SEEK, 0n, "files remain seekable");
});
