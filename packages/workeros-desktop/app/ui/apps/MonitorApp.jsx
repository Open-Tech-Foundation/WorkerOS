// System Monitor — one place to see everything the OS is running: the desktop's apps
// (from the WM store) above the kernel's real process table (os.ps()). Both tables
// carry the same right-click affordances as the rest of the DE.
//
// On CPU/RAM: the kernel does not account for them yet. `ps` reports pid / ppid /
// pgid / argv / cwd / state, and its `start_time` field is never fed a clock, so
// there is no honest per-process CPU, memory or uptime to show — and inventing a
// number in a system monitor would be worse than omitting it. When the kernel grows
// that accounting, the columns belong here.

import { onMount } from "@opentf/web";
import { wm } from "../../os/wm.js";
import { procs, startPolling, refreshProcs } from "../../os/processes.js";
import { contextMenu } from "../../os/menus.js";
import MonAppRow from "./MonAppRow.jsx";
import ProcRow from "./ProcRow.jsx";

export default function MonitorApp() {
  onMount(() => startPolling());

  // The distinct apps that currently have a window, in dock order of first appearance.
  const runningApps = () => {
    const seen = [];
    for (const w of wm.windows) if (!seen.includes(w.appId)) seen.push(w.appId);
    return seen;
  };

  const bgMenu = contextMenu([{ label: "Refresh", icon: "↻", action: () => refreshProcs() }]);

  return (
    <div class="app-mon" oncontextmenu={bgMenu}>
      <div class="mon-bar">
        <span class="mon-sum">
          {() =>
            `${runningApps().length} app${runningApps().length === 1 ? "" : "s"} · ` +
            `${wm.windows.length} window${wm.windows.length === 1 ? "" : "s"} · ` +
            (procs.loaded ? `${procs.list.length} process${procs.list.length === 1 ? "" : "es"}` : "loading…")
          }
        </span>
        <button class="proc-refresh" title="Refresh now" onclick={() => refreshProcs()}>↻</button>
      </div>

      <div class="mon-scroll">
        <section class="mon-sect">
          <h3 class="mon-h">Applications</h3>
          <div class="mon-table">
            <div class="mon-row mon-head">
              <span class="mon-app-ico" />
              <span class="mon-app-name">APP</span>
              <span class="mon-app-wins">WINDOWS</span>
              <span class="mon-app-state">STATE</span>
              <span class="mon-act" />
            </div>
            {runningApps().map((id) => (
              <MonAppRow key={id} appId={id} />
            ))}
          </div>
          {() => (wm.windows.length === 0 ? <div class="mon-empty">No apps running</div> : null)}
        </section>

        <section class="mon-sect">
          <h3 class="mon-h">Processes</h3>
          <div class="proc-table">
            <div class="proc-row proc-head">
              <span class="proc-pid">PID</span>
              <span class="proc-ppid">PPID</span>
              <span class="proc-state">STATE</span>
              <span class="proc-cmd">COMMAND</span>
              <span class="proc-act" />
            </div>
            <div class="proc-body">
              {procs.list.map((p) => (
                <ProcRow key={p.pid} proc={p} />
              ))}
            </div>
          </div>
          {() => (procs.error ? <div class="proc-error">{procs.error}</div> : null)}
        </section>
      </div>
    </div>
  );
}
