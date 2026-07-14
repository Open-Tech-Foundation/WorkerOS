// One row of the live process table. Takes a plain proc snapshot as a prop (the
// parent re-renders the list each poll, so a snapshot read is correct here) and
// offers SIGTERM / SIGKILL buttons. Matches the framework's `posts.map(p =>
// <PostCard post={p}/>)` idiom — the reactive lookup lives in the parent's map.

import { killProc } from "../../os/processes.js";

export default function ProcRow({ proc }) {
  const cmd = (proc.argv && proc.argv.join(" ")) || "—";
  const stop = proc.state !== "running" && proc.state !== "runnable";
  return (
    <div class={"proc-row" + (stop ? " is-stopped" : "")}>
      <span class="proc-pid">{String(proc.pid)}</span>
      <span class="proc-ppid">{String(proc.ppid)}</span>
      <span class={"proc-state st-" + proc.state}>{proc.state}</span>
      <span class="proc-cmd" title={cmd}>{cmd}</span>
      <span class="proc-act">
        <button class="proc-kill" title="SIGTERM" onclick={() => killProc(proc.pid, 15)}>term</button>
        <button class="proc-kill proc-kill9" title="SIGKILL" onclick={() => killProc(proc.pid, 9)}>kill</button>
      </span>
    </div>
  );
}
