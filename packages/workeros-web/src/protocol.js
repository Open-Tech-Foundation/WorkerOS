// Message framing for the main-thread ⇆ kernel-worker control channel.
//
// This is the *control* transport (postMessage). The synchronous syscall
// transport is a separate SharedArrayBuffer ring buffer (see ringbuffer.js).
// Keeping the two apart is deliberate: control is async and structured; syscalls
// are synchronous and byte-framed.

export const MSG = Object.freeze({
  // main → kernel
  BOOT: "boot",
  // kernel → main
  BOOTED: "booted",
  ERROR: "error",
});
