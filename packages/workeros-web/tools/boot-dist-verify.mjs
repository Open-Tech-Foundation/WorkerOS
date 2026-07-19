// End-to-end proof that the self-contained dist boots and runs a program — the
// whole user flow: load the bundled runtime by module → boot() → kernel →
// spawn a locally-installed program → read its output. Nothing is served from
// source; only packages/workeros-web/dist (+ its inlined deps) is exercised.
import { createDevServer } from "./serve.js";
import { chromium } from "playwright";

const server = createDevServer();
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp-dist.html`);
  await page.waitForFunction(() => window.__ready, { timeout: 20000 });
  const out = await page.evaluate(async () => {
    const os = await window.__wos.boot();
    const dec = new TextDecoder();
    const run = async (argv) => {
      const p = await os.spawn(argv, { cwd: "/" });
      let o = "";
      p.onStdout((b) => (o += dec.decode(b)));
      const code = await p.exited;
      return { o: o.trim(), code };
    };
    // echo (coreutil, from @opentf/workeros-coreutils) and a node script
    // (/bin/node, from @opentf/workeros-programs) — both inlined into the bundle.
    const echo = await run(["echo", "hello-from-dist"]);
    const node = await run(["node", "-e", "console.log(6*7)"]);
    return { echo, node };
  });
  console.log("echo:", JSON.stringify(out.echo));
  console.log("node:", JSON.stringify(out.node));
  console.log("pageerrors:", errors.length ? errors : "none");
  const ok = out.echo.o === "hello-from-dist" && out.echo.code === 0 &&
    out.node.o === "42" && out.node.code === 0 && errors.length === 0;
  console.log(ok ? "\n✅ DIST BOOTS AND RUNS PROGRAMS" : "\n❌ FAILED");
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
