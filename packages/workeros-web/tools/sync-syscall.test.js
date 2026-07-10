// Unit tests for the synchronous syscall transport (src/sync-syscall.js),
// including the request-payload path a synchronous `write` uses. Pure Node — no
// browser. The `signal` callback plays the kernel side *synchronously* (it writes
// the response before makeSyncCaller reaches Atomics.wait), so the round-trip
// completes on one thread without ever parking.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocSyncBuffer,
  makeSyncCaller,
  readRequest,
  requestBytes,
  writeResponse,
} from "../src/sync-syscall.js";

test("request carries JSON meta + raw bytes; response returns JSON value", () => {
  const sab = allocSyncBuffer();
  const syncCall = makeSyncCaller(sab, () => {
    const req = readRequest(sab);
    const bytes = requestBytes(sab);
    writeResponse(sab, 0, { call: req.call, fd: req.fd, got: Array.from(bytes) });
  });
  const r = syncCall("write", { fd: 5 }, false, new Uint8Array([1, 2, 3, 4]));
  assert.equal(r.status, 0);
  assert.deepEqual(r.value, { call: "write", fd: 5, got: [1, 2, 3, 4] });
});

test("a request with no bytes has empty requestBytes (backward compatible)", () => {
  const sab = allocSyncBuffer();
  let sawBytesLen = -1;
  const syncCall = makeSyncCaller(sab, () => {
    const req = readRequest(sab);
    sawBytesLen = requestBytes(sab).length;
    writeResponse(sab, 0, { path: req.path });
  });
  const r = syncCall("open", { path: "/a.txt" }, false);
  assert.equal(sawBytesLen, 0);
  assert.deepEqual(r.value, { path: "/a.txt" });
});

test("binary response returns raw bytes (a read)", () => {
  const sab = allocSyncBuffer();
  const syncCall = makeSyncCaller(sab, () => {
    readRequest(sab);
    writeResponse(sab, 0, new Uint8Array([9, 8, 7]));
  });
  const r = syncCall("read", { fd: 0, max: 3 }, true);
  assert.deepEqual(Array.from(r.bytes), [9, 8, 7]);
});

test("negative status carries the kernel error", () => {
  const sab = allocSyncBuffer();
  const syncCall = makeSyncCaller(sab, () => writeResponse(sab, -1, { error: "Noent" }));
  const r = syncCall("open", { path: "/missing" }, false);
  assert.equal(r.status, -1);
  assert.equal(r.value.error, "Noent");
});
