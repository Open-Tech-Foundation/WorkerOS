// The documentation section frame. Full `DocsLayout` chrome — its own navbar
// (with Pagefind search), sidebar, TOC, and footer. RootLayout (app/layout.jsx)
// omits the marketing nav/footer on /docs so there's no double navbar.
//
// The `import "@opentf/web-docs"` side effect registers the themed `web-*` custom
// elements (Callout, Tabs, Steps, …). Their styling (the docs theme) is `@import`ed
// from app/global.css — CSS can't be imported from JS in this pipeline (Rolldown
// dropped CSS bundling).
import "@opentf/web-docs";
import { DocsLayout } from "@opentf/web-docs";
import config from "../../otfw.config.js";

export default function DocsSectionLayout(props) {
  return <DocsLayout config={config.docs}>{props.children}</DocsLayout>;
}
