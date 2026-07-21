// The playground is a thin host: it mounts the full desktop, imported from the
// @opentf/workeros-desktop package. The desktop is DEVELOPED in that package; this
// app just runs it locally (against the local runtime build) so you can iterate.
// otfw compiles the package's JSX the same way it compiles @opentf/web-docs.
import { Desktop } from "@opentf/workeros-desktop";

export default function Home() {
  return <Desktop />;
}
