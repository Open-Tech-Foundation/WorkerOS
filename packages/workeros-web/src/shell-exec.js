// The `wsh` execution driver (host side).
//
// Parsing and glob expansion are done by the Rust kernel (`kernel.shell_plan`);
// this module only performs the parts that are inherently async host work:
// spawning a program worker per command, wiring pipes, sequencing `&&`/`||`,
// running the `cd` builtin, and backgrounding. Every *decision* it needs
// (resolve a command, open a pipe, stat a directory) is a call back into the
// kernel — INV-2 holds: the shell's logic is Rust; this is orchestration.

const enc = new TextEncoder();

/**
 * @param {object} deps
 * @param {*} deps.kernel        the wasm WebKernel
 * @param {Function} deps.startProcess  ({argv, env, cwd, plan, sink}) => {pid, exited}
 * @param {{cwd: string, env: Record<string,string>}} deps.session  mutable shell state
 */
export function createShell({ kernel, startProcess, session }) {
  /** Run a full command line; stream output to `sink`; resolve the exit code. */
  async function exec(line, sink) {
    let plan;
    try {
      plan = kernel.shell_plan(line, session.cwd);
    } catch (e) {
      sink.stderr(enc.encode(String(e.message || e) + "\n"));
      return 2;
    }
    let last = 0;
    for (const stmt of plan.statements) {
      if (stmt.background) {
        // Detach: the job keeps running; its exit does not block the prompt.
        runAndOr(stmt.steps, sink).catch(() => {});
        last = 0;
      } else {
        last = await runAndOr(stmt.steps, sink);
      }
    }
    return last;
  }

  async function runAndOr(steps, sink) {
    let code = await runPipeline(steps[0].commands, sink);
    for (let i = 1; i < steps.length; i++) {
      const step = steps[i];
      if ((step.op === "and" && code === 0) || (step.op === "or" && code !== 0)) {
        code = await runPipeline(step.commands, sink);
      }
    }
    return code;
  }

  async function runPipeline(commands, sink) {
    // A lone builtin (cd / bare assignment) runs in the shell itself — it must,
    // since a child process cannot change the shell's cwd or env.
    if (commands.length === 1) {
      const handled = tryBuiltin(commands[0], sink);
      if (handled !== null) return handled;
    }

    const n = commands.length;
    const pipes = [];
    for (let i = 0; i < n - 1; i++) pipes.push(kernel.pipe_open());

    const exits = [];
    for (let i = 0; i < n; i++) {
      const cmd = commands[i];
      const plan = buildStdioPlan(cmd, i, n, pipes);
      const env = { ...session.env, ...Object.fromEntries(cmd.assignments) };
      try {
        const { exited } = startProcess({ argv: cmd.argv, env, cwd: session.cwd, plan, sink });
        exits.push(exited);
      } catch (e) {
        sink.stderr(enc.encode((cmd.argv[0] || "wsh") + ": " + (e.message || e) + "\n"));
        exits.push(Promise.resolve(127));
      }
    }
    const codes = await Promise.all(exits);
    return codes[codes.length - 1];
  }

  function buildStdioPlan(cmd, i, n, pipes) {
    let stdin = i > 0 ? { kind: "pipe", id: pipes[i - 1], end: "read" } : { kind: "inherit" };
    let stdout = i < n - 1 ? { kind: "pipe", id: pipes[i], end: "write" } : { kind: "inherit" };
    let stderr = { kind: "inherit" };
    // Explicit redirects win over the pipe defaults.
    for (const r of cmd.redirects) {
      const target = { kind: "file", path: r.target, mode: r.op };
      if (r.fd === 0) stdin = target;
      else if (r.fd === 1) stdout = target;
      else if (r.fd === 2) stderr = target;
    }
    return { stdin, stdout, stderr };
  }

  /** Handle shell builtins; returns an exit code, or null if not a builtin. */
  function tryBuiltin(cmd, sink) {
    // A command that is only `NAME=value` assignments sets the shell env.
    if (cmd.argv.length === 0) {
      for (const [k, v] of cmd.assignments) session.env[k] = v;
      return 0;
    }
    if (cmd.argv[0] === "cd") {
      const target = cmd.argv[1] || session.env.HOME || "/";
      try {
        session.cwd = kernel.resolve_dir(session.cwd, target);
        return 0;
      } catch {
        sink.stderr(enc.encode("cd: " + target + ": No such file or directory\n"));
        return 1;
      }
    }
    return null;
  }

  return { exec };
}
