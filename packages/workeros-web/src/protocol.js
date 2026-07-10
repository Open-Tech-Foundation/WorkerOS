// Message framing for the WorkerOS control channels (postMessage).
//
// Two hops share these constants:
//   main  ⇆ kernel worker   (client control + streamed stdio/exit events)
//   kernel worker ⇆ program worker  (init + syscalls + exit)
//
// This is the *control* transport. The synchronous syscall transport for WASI
// guests is a separate per-process SharedArrayBuffer slot (sync-syscall.js); JS
// guests (Phase 2/3) only need this async channel because JS stdio does not block.

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
  // main → kernel: interactive terminal (xterm) channel
  TTY_INPUT: "tty_input", // raw keystrokes → the kernel line discipline
  RESIZE: "resize", // terminal window size changed
  TERM_START: "term_start", // begin the interactive shell REPL
  // kernel → main
  TERM_OUTPUT: "term_output", // bytes for the terminal display (prompt/echo/stdout)
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
  // program worker → kernel worker: "a synchronous syscall request is waiting in
  // the shared buffer" (WASI blocking calls; the reply travels via the SAB).
  SYNC: "sync",
  PROC_EXIT: "proc_exit",
  // kernel worker → program worker (syscall reply)
  SYSCALL_RESULT: "syscall_result",
});
