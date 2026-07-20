// Local testing app dev server for WorkerOS.
//
// Purpose: boot the OS from the *local* built packages (not the published npm
// releases, and independent of the website) so a source change can be verified
// end-to-end in a real browser. It serves the repo so `@opentf/workeros-web` and
// its inlined runtime + kernel .wasm all load from one cross-origin-isolated origin.
//
// What it does, and why each piece is needed:
//   • COOP/COEP/CORP headers  → `crossOriginIsolated === true`, which unlocks the
//     SharedArrayBuffer the kernel's synchronous syscalls need (ADR-010).
//   • bare-import rewriting    → the kernel/program workers are ES *module workers*
//     (no import map), so the browser can't resolve `@opentf/workeros-web`. We do
//     what a bundler would: resolve the specifier through Node (its package
//     `exports` → the local `dist/`) and rewrite it to a root-relative URL. This is
//     the seam that makes the app track the LOCAL build.
//
// It intentionally reuses nothing from website/ — the website tracks the published
// packages; this app is only for local iteration.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Serve from the repo root so both this app's files (/playground/…) and the
// resolved package dist (/packages/workeros-web/dist/…) live under one origin.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT) || 8099;

const BARE_IMPORT_RE = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;
const resolveCache = new Map();

function toRootUrl(fileUrl) {
  const abs = fileURLToPath(fileUrl);
  if (!abs.startsWith(ROOT)) return null; // outside the served tree
  return "/" + abs.slice(ROOT.length).split(sep).filter(Boolean).join("/");
}

function rewriteBareImports(source) {
  return source.replace(BARE_IMPORT_RE, (whole, kw, quote, spec) => {
    if (/^(\.\.?\/|\/|https?:|data:|node:)/.test(spec)) return whole; // not bare
    let url = resolveCache.get(spec);
    if (url === undefined) {
      try {
        url = toRootUrl(import.meta.resolve(spec));
      } catch {
        url = null;
      }
      resolveCache.set(spec, url);
    }
    return url ? `${kw}${quote}${url}${quote}` : whole;
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store"); // always serve the freshest local build
  try {
    let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (urlPath === "/") urlPath = "/playground/index.html";
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const ext = extname(filePath);
    let body = await readFile(filePath);
    if (ext === ".js" || ext === ".mjs") body = rewriteBareImports(body.toString("utf8"));
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.statusCode = 200;
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`\nWorkerOS local testing app → http://localhost:${PORT}/\n`);
  console.log("Serving the LOCAL build of @opentf/workeros-web (its dist/ + kernel wasm).");
  console.log("After changing runtime source, rebuild then refresh:  npm run build\n");
});
