// A placeholder app so the window manager is demonstrable before the real apps
// exist. `onMount` bumps a global so a test can prove windows aren't remounted when
// the window list changes (keyed reconciliation).

import { onMount } from "@opentf/web";

export default function WelcomeApp() {
  onMount(() => {
    window.__wosMountCount = (window.__wosMountCount || 0) + 1;
  });
  return (
    <div class="app-welcome">
      <div class="app-welcome-mark">W</div>
      <h2>WorkerOS desktop</h2>
      <p>
        A real kernel in a Web Worker, now with a windowed shell. Drag this window by
        its title bar, resize from any edge, and use the controls on the right to
        minimize, maximize, or close it.
      </p>
      <p class="app-welcome-hint">Terminal, Files, and the browser arrive next.</p>
    </div>
  );
}
