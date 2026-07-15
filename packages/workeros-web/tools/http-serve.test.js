// End-to-end HTTP serving over the kernel loopback (ADR-021): a guest process runs
// `http.createServer` with an ASYNC handler and listens; a SEPARATE guest process
// fetches it. This guards the path a preview server (Vite) takes — and the fixes
// that make it work: a client half-closes after its request, so the server socket
// must stay half-open (else the request-side EOF tears down the response before an
// async handler writes it); socket-data chunks need a real Buffer; and the client's
// IncomingMessage needs `setEncoding`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDevServer } from "./serve.js";

let chromium;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }
const opts = { skip: chromium ? false : "playwright not installed", timeout: 60000 };

async function withOs(fn) {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp.html`);
    await page.waitForFunction(() => window.__ready, { timeout: 15000 });
    return await page.evaluate(fn);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

test("http server serves an async handler to a separate client over loopback", opts, async () => {
  const res = await withOs(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    // Server: responds only AFTER an await — the case that used to lose the response.
    const srv = [
      "const http = require('http');",
      "const s = http.createServer(async (req, res) => {",
      "  await new Promise((r) => setTimeout(r, 20));",
      "  res.writeHead(200, { 'Content-Type': 'text/plain' });",
      "  res.end('async-body:' + req.url);",
      "});",
      "s.listen(5188, '127.0.0.1', () => console.error('READY'));",
    ].join("\n");
    const sp = await os.spawn(["node", "-e", srv], { cwd: "/" });
    let sErr = "";
    sp.onStderr((b) => (sErr += dec.decode(b)));
    for (let i = 0; i < 40 && !sErr.includes("READY"); i++) await new Promise((r) => setTimeout(r, 250));

    // Client: a separate process fetches it (half-closes after the request).
    const cli = [
      "const http = require('http');",
      "http.get('http://127.0.0.1:5188/hello', (r) => {",
      "  let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c));",
      "  r.on('end', () => { console.log('S' + r.statusCode + '|' + d); process.exit(0); });",
      "}).on('error', (e) => { console.log('ERR ' + e.message); process.exit(1); });",
      "setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 10000);",
    ].join("\n");
    const cp = await os.spawn(["node", "-e", cli], { cwd: "/" });
    let out = "";
    cp.onStdout((b) => (out += dec.decode(b)));
    const code = await Promise.race([cp.exited, new Promise((r) => setTimeout(() => r("TIMEOUT"), 15000))]);
    return { code, out: out.trim(), ready: sErr.includes("READY") };
  });

  assert.ok(res.ready, "server should reach listening");
  assert.equal(res.code, 0, JSON.stringify(res));
  assert.equal(res.out, "S200|async-body:/hello");
});
