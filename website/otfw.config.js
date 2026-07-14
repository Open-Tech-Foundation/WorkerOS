import { defineDocsConfig } from "@opentf/web-docs/config";

// Enabling a `docs` block makes @opentf/web-cli register the docs nav generator,
// so `@opentf/web-docs/nav` resolves to a sidebar tree built from app/docs/**.
// The docs section renders with `frame={false}` (app/docs/layout.jsx) so it lives
// inside the site's own navbar/footer — these fields drive the sidebar, TOC, and
// the per-page "Edit this page" link.
export default defineDocsConfig({
  // TODO: set to the real production domain — drives canonical URLs + sitemap.
  site: { url: "https://workeros.opentechf.org" },
  docs: {
    title: "WorkerOS",
    dir: "docs",
    homeUrl: "/",
    github: "https://github.com/Open-Tech-Foundation/WorkerOS",
    repoUrl: "https://github.com/Open-Tech-Foundation/WorkerOS",
    // Pagefind full-text search — indexed from the built HTML by `otfw build`;
    // renders the navbar search trigger (⌘K).
    search: { provider: "pagefind" },
    // Top-level navbar links — shared by the marketing shell (RootLayout) and the
    // docs chrome (DocsLayout), so the whole site carries one navbar.
    nav: [
      { label: "Docs", href: "/docs" },
      { label: "Playground", href: "/playground" },
    ],
  },
});
