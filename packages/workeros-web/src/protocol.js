// Message framing for the WorkerOS control channels (postMessage).
//
// Two hops share these constants:
//   main  ⇆ kernel worker   (client control + streamed stdio/exit events)
//   kernel worker ⇆ program worker  (init + syscalls + exit)
//
// This is the *control* transport. The synchronous syscall transport for WASI
// guests is a separate SharedArrayBuffer ring buffer (ringbuffer.js); JS guests
// (Phase 2/3) only need this async channel because JS stdio does not block.

export const MSG = Object.freeze({
  // main → kernel
  BOOT: "boot",
  FS_WRITE: "fs_write",
  FS_READ: "fs_read",
  SPAWN: "spawn",
  EXEC: "exec",
  PS: "ps",
  KILL: "kill",
  STDIN: "stdin",
  // kernel → main
  BOOTED: "booted",
  SPAWNED: "spawned",
  STDOUT: "stdout",
  STDERR: "stderr",
  EXIT: "exit",
  EXEC_STDOUT: "exec_stdout",
  EXEC_STDERR: "exec_stderr",
  EXEC_DONE: "exec_done",
  PS_RESULT: "ps_result",
  ERROR: "error",

  // kernel worker → program worker
  START: "start",
  // program worker → kernel worker
  SYSCALL: "syscall",
  PROC_EXIT: "proc_exit",
  // kernel worker → program worker (syscall reply)
  SYSCALL_RESULT: "syscall_result",
});
