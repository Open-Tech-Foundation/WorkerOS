// Renders a window's app body from its `appId`. The OTF Web compiler compiles each
// component to a custom element, so app components must be written as literal tags
// (not dispatched through a variable). This chain is the one place that maps an id
// to its component; each new real app adds an import + a branch. Ids without a real
// component yet fall through to the shared placeholder.

import WelcomeApp from "./apps/WelcomeApp.jsx";
import TerminalApp from "./apps/TerminalApp.jsx";
import ProcessesApp from "./apps/ProcessesApp.jsx";
import FilesApp from "./apps/FilesApp.jsx";
import EditorApp from "./apps/EditorApp.jsx";
import AboutApp from "./apps/AboutApp.jsx";
import PlaceholderApp from "./apps/PlaceholderApp.jsx";

export default function AppView({ win }) {
  // appId is fixed for a window, so a plain chain (not a reactive block) is fine.
  const id = win.appId;
  return id === "terminal" ? <TerminalApp win={win} />
    : id === "processes" ? <ProcessesApp win={win} />
    : id === "files" ? <FilesApp win={win} />
    : id === "editor" ? <EditorApp win={win} />
    : id === "welcome" ? <WelcomeApp win={win} />
    : id === "about" ? <AboutApp win={win} />
    : <PlaceholderApp win={win} />;
}
