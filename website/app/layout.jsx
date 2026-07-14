import "@opentf/web-docs";
import { router } from "@opentf/web";
import { Navbar } from "@opentf/web-docs";
import config from "../otfw.config.js";

export default function RootLayout({ children }) {
  // Two routes render without the marketing shell: /docs supplies its own full
  // chrome via DocsLayout (avoiding a double navbar), and /playground is a
  // full-viewport desktop that owns the whole screen. Everything else gets the
  // shared navbar + footer. The check lives inside the returned JSX (not an early
  // return) so client-side navigation reactively swaps chrome.
  const isBare = $derived(
    router.pathname.startsWith("/docs") || router.pathname.startsWith("/playground"),
  );

  return isBare ? (
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
