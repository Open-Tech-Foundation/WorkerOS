// A minimal static file server that sets the cross-origin isolation headers
// (COOP/COEP) SharedArrayBuffer requires (ADR-010, ARCHITECTURE.md §11).
//
// This is a dev/test harness, not a production server. It serves the package
// directory so the ESM host runtime, the kernel worker, and the .wasm binary
// all load from one cross-origin-isolated origin.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Serve from the repo root so both cross-package ESM imports (the program
// worker loads the workeros-programs/node tenant shim) and the examples/ demos resolve.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// The runtime imports its sibling packages *by name* (`@opentf/workeros-programs`,
// `@opentf/workeros-coreutils`, …) — resolved by a bundler in production. The
// kernel/program workers are ES *module workers*, which cannot use an import map,
// so the browser can't resolve a bare specifier there. This dev/test server does
// what the bundler would: it rewrites bare specifiers in served JS to `ROOT`-
// relative URLs, resolving them through Node's module resolution (the packages'
// `exports` maps → their built `dist/`). Relative/absolute specifiers pass through.
const BARE_IMPORT_RE = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;
const resolveCache = new Map();

function toRootUrl(fileUrl) {
  const abs = fileURLToPath(fileUrl);
  if (!abs.startsWith(ROOT)) return null; // outside the served tree
  return "/" + abs.slice(ROOT.length).split(sep).filter(Boolean).join("/");
}

function rewriteBareImports(source) {
  return source.replace(BARE_IMPORT_RE, (whole, kw, quote, spec) => {
    // Leave relative, absolute, and URL specifiers untouched.
    if (/^(\.\.?\/|\/|https?:|data:|node:)/.test(spec)) return whole;
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
};

function crossOriginIsolationHeaders(res) {
  // These two headers make `crossOriginIsolated === true`, which unlocks
  // SharedArrayBuffer.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  // Allow the worker/wasm sub-resources to be embedded under COEP.
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

export function createDevServer() {
  return createServer(async (req, res) => {
    crossOriginIsolationHeaders(res);
    try {
      let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (urlPath === "/") urlPath = "/packages/workeros-web/tools/harness.html";
      // Prevent path traversal outside ROOT.
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
      // Rewrite bare import specifiers so ES module workers resolve sibling
      // packages without a bundler or import map (see rewriteBareImports).
      if (ext === ".js" || ext === ".mjs") {
        body = rewriteBareImports(body.toString("utf8"));
      }
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.statusCode = 200;
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
}

// Run directly: `node tools/serve.js [port]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8080;
  createDevServer().listen(port, () => {
    console.log(`WorkerOS dev server (cross-origin isolated) on http://localhost:${port}`);
  });
}
