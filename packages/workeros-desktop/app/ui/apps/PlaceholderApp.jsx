// A generic app body for registry apps whose real component hasn't landed yet
// (Terminal, Files, Browser, Editor, Processes, About). It reflects the window's
// own icon + title so each still feels like a distinct app, and names when the real
// one arrives. Replaced per-app as later phases build the real components.

export default function PlaceholderApp({ win }) {
  return (
    <div class="app-soon">
      <div class="app-soon-ico">{win.icon}</div>
      <h2>{win.title}</h2>
      <p>This app is on the way — it arrives in a later build of the WorkerOS desktop.</p>
    </div>
  );
}
