// The desktop is the whole app here: the root route mounts the full-viewport
// window-manager shell. (On the website this same UI lives at /playground; extracted
// here so the desktop can be developed on its own, against the local runtime build.)
import Desktop from "./ui/Desktop.jsx";

export default function Home() {
  return <Desktop />;
}
