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
  // main → kernel: persist the durable filesystem now (e.g. tab hidden/closing).
  FS_FLUSH: "fs_flush",
  // main → kernel: interactive terminal (xterm) channel
  TTY_INPUT: "tty_input", // raw keystrokes → the kernel line discipline
  RESIZE: "resize", // terminal window size changed
  TERM_START: "term_start", // begin the interactive shell REPL
  // main → kernel: a preview HTTP request to inject into a listening process
  // (ADR-021). Carries { id, port, bytes } (raw HTTP/1.1 request); the reply is
  // PREVIEW_RESPONSE with the raw HTTP/1.1 response bytes.
  PREVIEW_REQUEST: "preview_request",
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
  // kernel → main: the raw HTTP/1.1 response bytes for a PREVIEW_REQUEST (ADR-021),
  // as { id, ok, bytes?, error? }.
  PREVIEW_RESPONSE: "preview_response",
  ERROR: "error",
  // main ⇆ kernel: opt-in kernel tracing (strace-style). The request carries
  // { on?, dump?, clear?, procs?, limit? }; the reply { on, events?, procs? }
  // returns the recent syscall/spawn/exit ring buffer and/or a live process
  // snapshot. Off by default (zero cost); a debugging aid, not a boot dependency.
  TRACE: "trace",
  TRACE_RESULT: "trace_result",

  // kernel worker → program worker
  START: "start",
  // kernel worker → program worker: deliver a cooperative signal (SIGINT/SIGWINCH/
  // SIGTSTP) to a JS guest that registered a handler.
  SIGNAL: "signal",
  // kernel worker → program worker: a filesystem change matched one of this
  // process's `fs.watch` registrations. Carries { watchId, eventType, filename }.
  FS_EVENT: "fs_event",
  // kernel worker → program worker: live stdio/exit of a child this process
  // spawned via node:child_process (`spawnChild`). Carry { pid, data } / { pid,
  // code, signal }. Routed to the guest's child dispatcher (`sys.onChildEvent`).
  CHILD_STDOUT: "child_stdout",
  CHILD_STDERR: "child_stderr",
  CHILD_EXIT: "child_exit",
  // kernel worker → program worker: node:worker_threads traffic. A structured-clone
  // message relayed between a Worker and its spawner ({ threadId, data }; threadId
  // 0 = the parent), or a worker's exit ({ threadId, code }). Routed to the guest's
  // worker dispatcher (`sys.onWorkerEvent`).
  WORKER_MESSAGE: "worker_message",
  WORKER_EXIT: "worker_exit",
  // kernel worker → program worker: a worker threw an uncaught error; relayed to
  // the spawner so `worker.on('error')` fires with a reconstructed Error
  // ({ threadId, message, stack, name }).
  WORKER_ERROR: "worker_error",
  // program worker → kernel worker
  SYSCALL: "syscall",
  // program worker → kernel worker: this process (if it is a worker) threw an
  // uncaught error; the kernel relays it to the spawner as WORKER_ERROR before the
  // process's exit. Carries { message, stack, name }.
  WORKER_ERROR_REPORT: "worker_error_report",
  // program worker → kernel worker: the guest installed/removed a handler for a
  // signal, so the kernel routes it cooperatively instead of hard-killing.
  SIGACTION: "sigaction",
  // program worker → kernel worker: "a synchronous syscall request is waiting in
  // the shared buffer" (WASI blocking calls; the reply travels via the SAB).
  SYNC: "sync",
  PROC_EXIT: "proc_exit",
  // kernel worker → program worker (syscall reply)
  SYSCALL_RESULT: "syscall_result",
});
