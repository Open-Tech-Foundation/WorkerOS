// The "About this system" box: WorkerOS branding, a one-line description, and the
// live kernel version/ABI read from the shared client once it has booted. Booting
// here is cheap when a Terminal is already open (the kernel is a singleton); on its
// own it just brings the kernel up a little early.

import { onMount } from "@opentf/web";
import { getOS } from "../../os/os.js";

export default function AboutApp() {
  let version = $state("…");
  let abi = $state("…");

  onMount(() => {
    let disposed = false;
    getOS().then((os) => {
      if (disposed) return;
      version = os.version || "unknown";
      abi = os.abi != null ? String(os.abi) : "—";
    });
    return () => { disposed = true; };
  });

  return (
    <div class="app-about">
      <div class="app-about-mark">W</div>
      <h2>WorkerOS</h2>
      <p class="app-about-tag">A real kernel, running as a tenant of your browser.</p>
      <dl class="app-about-meta">
        <div><dt>Kernel</dt><dd>{version}</dd></div>
        <div><dt>Syscall ABI</dt><dd>{abi}</dd></div>
        <div><dt>Host</dt><dd>Web Worker · WASM</dd></div>
      </dl>
    </div>
  );
}
