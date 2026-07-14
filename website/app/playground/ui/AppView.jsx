// Renders a window's app body from its `appId`. The OTF Web compiler compiles each
// component to a custom element, so app components must be written as literal tags
// (not dispatched through a variable). This switch is the one place that maps an id
// to its component; each new app adds an import + a branch here.

import WelcomeApp from "./apps/WelcomeApp.jsx";

export default function AppView({ win }) {
  const id = win.appId;
  return id === "welcome" ? <WelcomeApp win={win} /> : null;
}
