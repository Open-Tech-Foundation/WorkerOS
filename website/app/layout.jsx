import { Link } from "@opentf/web";

export default function RootLayout({ children }) {
  return (
    <div class="app">
      <header class="nav">
        <div class="container nav-inner">
          <Link href="/" class="brand">
            <span>Worker<b>OS</b></span>
          </Link>
          <span class="nav-spacer" />
          <nav class="nav-links">
            <Link href="/playground" class="nav-cta">
              Playground
            </Link>
            <a
              class="nav-icon nav-icon-plain"
              href="https://github.com/Open-Tech-Foundation/WorkerOS"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              title="GitHub"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.54 2.87 8.39 6.84 9.75.5.1.68-.22.68-.48v-1.72c-2.78.62-3.37-1.21-3.37-1.21-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1.01.08 1.55 1.06 1.55 1.06.9 1.59 2.36 1.13 2.93.86.09-.66.35-1.13.64-1.39-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.38-2.03 1.01-2.75-.1-.26-.44-1.31.1-2.72 0 0 .83-.27 2.7 1.05a9.1 9.1 0 0 1 4.92 0c1.87-1.32 2.7-1.05 2.7-1.05.54 1.41.2 2.46.1 2.72.63.72 1.01 1.63 1.01 2.75 0 3.94-2.35 4.8-4.58 5.05.36.32.68.95.68 1.93v2.86c0 .26.18.59.69.48A10.14 10.14 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
              </svg>
            </a>
          </nav>
        </div>
      </header>

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
