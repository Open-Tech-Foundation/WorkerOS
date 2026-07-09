// A minimal static file server that sets the cross-origin isolation headers
// (COOP/COEP) SharedArrayBuffer requires (ADR-010, ARCHITECTURE.md §11).
//
// This is a dev/test harness, not a production server. It serves the package
// directory so the ESM host runtime, the kernel worker, and the .wasm binary
// all load from one cross-origin-isolated origin.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
      if (urlPath === "/") urlPath = "/tools/harness.html";
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
      const body = await readFile(filePath);
      res.setHeader("Content-Type", MIME[extname(filePath)] || "application/octet-stream");
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
