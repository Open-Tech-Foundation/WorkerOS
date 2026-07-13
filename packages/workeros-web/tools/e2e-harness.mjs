// Reusable end-to-end harness for driving real programs inside WorkerOS from
// Node — boot the OS in headless Chromium, run a command, answer interactive
// prompts, and (crucially, for debugging) capture the kernel trace + a process
// and filesystem snapshot when it finishes OR hangs.
//
// Use it two ways:
//   • programmatically:  import { runInOs } from "./e2e-harness.mjs"
//   • from the CLI:      node tools/e2e-harness.mjs --cwd /app --snap /app -- npm create hono@latest my-app
//
// Interactive prompts are answered with `--on "<regex>=<keys>"` rules: when the
// program's output matches <regex>, the harness sends <keys> to its stdin once.
// `\n \r \t [A` (up) `[B` (down) escapes are understood, so you can
// script an arrow-key menu. `--after "<ms>=<keys>"` sends on a timer instead.
//
// The kernel trace (every syscall + spawn/exit) streams live as `[wos] …` console
// lines and is also dumped structured at the end — that is how you see WHERE a
// hang is (which fd a read is parked on, which path can't be found, whether a
// child ever spawned). See os.trace() in src/client.js.

import { createDevServer } from "./serve.js";
import { chromium } from "playwright";

const UNESCAPE = (s) =>
  s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\e/g, "\x1b");

/**
 * Run one command inside a freshly-booted OS.
 * @param {object} o
 * @param {string[]} o.argv           e.g. ["npm","create","hono@latest","my-app"]
 * @param {string}   [o.cwd="/"]
 * @param {object}   [o.env]
 * @param {Array<{when: string|number, send: string, once?: boolean}>} [o.inputs]
 *        `when` is a regex tested against accumulated stdout+stderr, or a number
 *        of ms after launch; `send` is the (unescaped) bytes to write to stdin.
 * @param {number}   [o.timeoutMs=60000]
 * @param {string[]} [o.snapshot]     dirs to list (recursively, with sizes) at the end
 * @param {Array<{path:string,src:string}>} [o.files]  files to write before running
 * @param {number}   [o.traceLimit=400]
 * @returns {Promise<{code:any, stdout:string, stderr:string, trace:any[], procs:any[], snapshots:object}>}
 */
export async function runInOs(o) {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const consoleLines = [];
  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      const t = m.text();
      if (t.startsWith("[wos]")) consoleLines.push(t);
    });
    page.on("pageerror", (e) => consoleLines.push("[pageerror] " + e.message));
    await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp.html`);
    await page.waitForFunction(() => window.__ready, { timeout: 20000 });

    const result = await page.evaluate(async (o) => {
      const dec = new TextDecoder();
      const os = await window.__wos.boot();
      await os.trace({ on: true, clear: true });
      for (const f of o.files || []) await os.fs.write(f.path, f.src);

      const proc = await os.spawn(o.argv, { cwd: o.cwd || "/", env: o.env || {} });
      let out = "", err = "", all = "";
      const fired = new Set();
      proc.onStdout((b) => { const s = dec.decode(b); out += s; all += s; drive(); });
      proc.onStderr((b) => { const s = dec.decode(b); err += s; all += s; drive(); });

      // Output-triggered inputs: whenever accumulated output matches a rule's
      // regex, send its keys once. Timer inputs are armed up front.
      function drive() {
        for (let i = 0; i < (o.inputs || []).length; i++) {
          const rule = o.inputs[i];
          if (fired.has(i) || typeof rule.when === "number") continue;
          if (new RegExp(rule.when).test(all)) { fired.add(i); console.debug(`[wos] input rule ${i} fired (${rule.when}) → ${JSON.stringify(rule.send)}`); try { proc.writeStdin(rule.send); } catch (e) { console.debug("[wos] writeStdin threw " + e); } }
        }
      }
      for (let i = 0; i < (o.inputs || []).length; i++) {
        const rule = o.inputs[i];
        if (typeof rule.when === "number") setTimeout(() => { if (!fired.has(i)) { fired.add(i); try { proc.writeStdin(rule.send); } catch {} } }, rule.when);
      }

      const code = await Promise.race([
        proc.exited,
        new Promise((r) => setTimeout(() => r("TIMEOUT"), o.timeoutMs || 60000)),
      ]);
      if (code === "TIMEOUT") { try { proc.kill(); } catch {} }

      const t = await os.trace({ dump: true, procs: true, limit: o.traceLimit || 400 });
      // Filesystem snapshots: `os.fs` has no recursive readdir, so run a tiny guest
      // node script that walks each dir and prints `path\tsize` lines.
      const snapshots = {};
      if ((o.snapshot || []).length) {
        const walk = `
const fs=require('node:fs');
function w(d){let out=[];let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch(e){return [[d,'<'+e.code+'>']]}
for(const e of es){const p=d.replace(/\\/$/,'')+'/'+e.name; if(e.isDirectory())out=out.concat(w(p)); else {let s=-1;try{s=fs.statSync(p).size}catch{}out.push([p,s])}} return out;}
for(const d of ${JSON.stringify(o.snapshot)}){console.log('SNAP '+d);for(const [p,s] of w(d))console.log(p+'\\t'+s);console.log('ENDSNAP');}
`;
        await os.fs.write("/tmp/_walk.js", walk);
        const wp = await os.spawn(["node", "/tmp/_walk.js"], { cwd: "/" });
        let wo = "";
        wp.onStdout((b) => (wo += dec.decode(b)));
        await Promise.race([wp.exited, new Promise((r) => setTimeout(r, 8000))]);
        let cur = null;
        for (const line of wo.split("\n")) {
          if (line.startsWith("SNAP ")) { cur = line.slice(5); snapshots[cur] = []; }
          else if (line === "ENDSNAP") cur = null;
          else if (cur && line) snapshots[cur].push(line);
        }
      }
      return { code, stdout: out, stderr: err, trace: t.events || [], procs: t.procs || [], snapshots };
    }, o);

    result.consoleTail = consoleLines.slice(-(o.traceLimit || 400));
    return result;
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

/**
 * Drive a command in the *interactive terminal* (the real user path): start the
 * shell REPL, type a command line, and answer prompts by sending keystrokes over
 * the TTY — so input reaches whatever foreground process is reading, however
 * deeply nested (npm → npm-cli → npx → the tool), exactly as a human's typing
 * does. This is how you exercise raw-mode prompts (@clack, inquirer) end to end.
 * @param {object} o
 * @param {string} o.command          the shell line to run (no trailing newline)
 * @param {Array<{when:string|number, send:string}>} [o.inputs]
 * @param {number} [o.timeoutMs=90000]
 * @param {string} [o.doneWhen]       regex that means the run is finished
 * @param {string[]} [o.snapshot]
 * @param {Array<{path:string,src:string}>} [o.files]
 */
export async function runInTerminal(o) {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const consoleLines = [];
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { const t = m.text(); if (t.startsWith("[wos]")) consoleLines.push(t); });
    page.on("pageerror", (e) => consoleLines.push("[pageerror] " + e.message));
    await page.goto(`http://localhost:${port}/packages/workeros-web/tools/mvp.html`);
    await page.waitForFunction(() => window.__ready, { timeout: 20000 });

    const result = await page.evaluate(async (o) => {
      const dec = new TextDecoder();
      const os = await window.__wos.boot();
      await os.trace({ on: true, clear: true });
      for (const f of o.files || []) await os.fs.write(f.path, f.src);

      let out = "";
      const fired = new Set();
      os.onOutput((b) => {
        out += dec.decode(b);
        for (let i = 0; i < (o.inputs || []).length; i++) {
          const rule = o.inputs[i];
          if (fired.has(i) || typeof rule.when === "number") continue;
          if (new RegExp(rule.when).test(out)) { fired.add(i); console.debug(`[wos] tty input ${i} (${rule.when}) → ${JSON.stringify(rule.send)}`); os.input(rule.send); }
        }
      });
      os.resize(30, 100);
      os.startTerminal();
      await new Promise((r) => setTimeout(r, 400)); // let the prompt render
      os.input(o.command + "\n"); // type the command
      for (let i = 0; i < (o.inputs || []).length; i++) {
        const rule = o.inputs[i];
        if (typeof rule.when === "number") setTimeout(() => { if (!fired.has(i)) { fired.add(i); os.input(rule.send); } }, rule.when);
      }

      const done = await Promise.race([
        (async () => { const re = o.doneWhen ? new RegExp(o.doneWhen) : null; for (;;) { await new Promise((r) => setTimeout(r, 300)); if (re && re.test(out)) return "DONE"; } })(),
        new Promise((r) => setTimeout(() => r("TIMEOUT"), o.timeoutMs || 90000)),
      ]);

      const t = await os.trace({ dump: true, procs: true, limit: o.traceLimit || 300 });
      const snapshots = {};
      if ((o.snapshot || []).length) {
        const walk = `
const fs=require('node:fs');
function w(d){let out=[];let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch(e){return [[d,'<'+e.code+'>']]}
for(const e of es){const p=d.replace(/\\/$/,'')+'/'+e.name; if(e.isDirectory())out=out.concat(w(p)); else {let s=-1;try{s=fs.statSync(p).size}catch{}out.push([p,s])}} return out;}
for(const d of ${JSON.stringify(o.snapshot)}){console.log('SNAP '+d);for(const [p,s] of w(d))console.log(p+'\\t'+s);console.log('ENDSNAP');}
`;
        await os.fs.write("/tmp/_walk.js", walk);
        const wp = await os.spawn(["node", "/tmp/_walk.js"], { cwd: "/" });
        let wo = ""; wp.onStdout((b) => (wo += dec.decode(b)));
        await Promise.race([wp.exited, new Promise((r) => setTimeout(r, 8000))]);
        let cur = null;
        for (const line of wo.split("\n")) {
          if (line.startsWith("SNAP ")) { cur = line.slice(5); snapshots[cur] = []; }
          else if (line === "ENDSNAP") cur = null;
          else if (cur && line) snapshots[cur].push(line);
        }
      }
      return { done, output: out, trace: t.events || [], procs: t.procs || [], snapshots };
    }, o);
    result.consoleTail = consoleLines.slice(-(o.traceLimit || 300));
    return result;
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

// ---- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const o = { inputs: [], snapshot: [] };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--cwd") o.cwd = args[++i];
    else if (a === "--timeout") o.timeoutMs = +args[++i];
    else if (a === "--snap") o.snapshot.push(args[++i]);
    else if (a === "--on") { const [w, ...k] = args[++i].split("="); o.inputs.push({ when: w, send: UNESCAPE(k.join("=")) }); }
    else if (a === "--after") { const [w, ...k] = args[++i].split("="); o.inputs.push({ when: +w, send: UNESCAPE(k.join("=")) }); }
    else if (a === "--") rest.push(...args.slice(i + 1)), (i = args.length);
    else rest.push(a);
  }
  o.argv = rest;
  const res = await runInOs(o);
  console.log("\n===== EXIT:", res.code, "=====");
  console.log("\n----- STDOUT -----\n" + res.stdout.slice(-4000));
  if (res.stderr.trim()) console.log("\n----- STDERR -----\n" + res.stderr.slice(-2000));
  console.log("\n----- LIVE PROCESSES AT END -----");
  for (const p of res.procs) console.log(" ", JSON.stringify(p));
  console.log("\n----- KERNEL TRACE (tail) -----");
  for (const e of res.trace.slice(-Number(process.env.TRACE_TAIL || 120)))
    console.log(`  #${e.seq} +${e.t}ms pid=${e.pid} ${e.kind}:${e.call}${e.info ? " " + e.info : ""}`);
  for (const [dir, snap] of Object.entries(res.snapshots)) {
    console.log(`\n----- FS SNAPSHOT ${dir} -----`);
    console.log(typeof snap === "string" ? snap : JSON.stringify(snap, null, 1).slice(0, 3000));
  }
  process.exit(0);
}
