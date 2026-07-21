// The OS boot splash — what you see while the kernel comes up.
//
// It covers the desktop until os/boot.js reports every stage done, then fades out and
// unmounts. It's part of the static markup, so it paints on first frame (no blank
// page while the worker/wasm graph loads) and it reports the real stage the OS is on
// rather than an indeterminate spinner.

import { effect, onMount, reactive } from "@opentf/web";
import { bootState } from "../os/boot.js";

export default function BootSplash() {
  // `gone` unmounts the splash one transition after boot lands, so the fade-out is
  // actually seen; `fade` starts it.
  const st = reactive({ fade: false, gone: false });

  onMount(() => {
    let t = null;
    effect(() => {
      if (!bootState.done || st.fade) return;
      st.fade = true;
      t = setTimeout(() => (st.gone = true), 420);
    });
    return () => clearTimeout(t);
  });

  return st.gone ? null : (
    <div class={"boot" + (st.fade ? " is-done" : "")}>
      <div class="boot-mark">
        <div class="boot-ring" />
        <div class="boot-logo">W</div>
      </div>
      <div class="boot-name">WorkerOS</div>
      <div class="boot-bar">
        <div class="boot-fill" style={`width:${Math.round((bootState.step / bootState.total) * 100)}%`} />
      </div>
      <div class="boot-step">{() => (bootState.error ? bootState.error : bootState.label)}</div>
    </div>
  );
}
