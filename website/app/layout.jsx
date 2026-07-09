import { Link } from "@opentf/web";

export default function RootLayout({ children }) {
  return (
    <div class="app">
      <header class="nav">
        <div class="container nav-inner">
          <Link href="/" class="brand">
            <span class="brand-mark">W</span>
            <span>Worker<b>OS</b></span>
          </Link>
          <span class="nav-spacer" />
          <nav class="nav-links">
            <a href="/#what">Overview</a>
            <a href="/#architecture">Architecture</a>
            <a href="/#milestones">Milestones</a>
            <a
              href="https://github.com/Open-Tech-Foundation"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            <Link href="/playground" class="nav-cta">
              Playground
            </Link>
          </nav>
        </div>
      </header>

      <main class="main">{children}</main>

      <footer class="footer">
        <div class="container footer-inner">
          <span>
            WorkerOS — an OS personality that boots in a Web Worker. Apache-2.0.
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
