import "@opentf/web-docs";
import { router } from "@opentf/web";
import { Navbar } from "@opentf/web-docs";
import config from "../otfw.config.js";

export default function RootLayout({ children }) {
  // The /docs section renders its own full chrome (the same Navbar plus a sidebar,
  // TOC, and footer) via DocsLayout, so the marketing shell is omitted there — avoids
  // a double navbar. The conditional lives inside the returned JSX (not an early
  // return) so client-side navigation reactively swaps chrome.
  const isDocs = $derived(router.pathname.startsWith("/docs"));

  return isDocs ? (
    <>{children}</>
  ) : (
    <div class="app">
      <Navbar config={config.docs} />

      <main class="main">{children}</main>

      <footer class="footer">
        <div class="container footer-inner">
          <span>
            <a href="https://opentechf.org" target="_blank" rel="noreferrer">
              Open Tech Foundation
            </a>
          </span>
          <span>
            Built with{" "}
            <a href="https://web.opentechf.org/" target="_blank" rel="noreferrer">
              OTF Web
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
