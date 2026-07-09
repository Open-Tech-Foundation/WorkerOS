// `curl` — download a URL into the VFS (or to stdout). A guest program (INV-1),
// installed at /bin/curl and run from wsh. It uses the worker's `fetch` (ADR-008:
// outbound fetch to a CORS-enabled host) and writes bytes through the `sys` ABI,
// so you can pull a wasm binary and run it:
//
//   curl -o /hello.wasm https://example.com/hello.wasm
//   /hello.wasm
//
// Cross-origin URLs must send CORS headers (and, under cross-origin isolation, be
// CORP/CORS-fetchable); otherwise the fetch fails — reported honestly (INV-5).
//
// Authored as a plain top-level-await script (no import/export) so it runs through
// the program worker's ESM path, which awaits top-level await.

const enc = new TextEncoder();
const out = (bytes) => sys.write(1, bytes);
const err = (s) => sys.write(2, enc.encode(s));

function join(...parts) {
  const segs = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return "/" + segs.join("/");
}
const dirname = (p) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};
const abs = (p) => (p.startsWith("/") ? p : join(sys.cwd, p));

async function mkdirp(dir) {
  let cur = "";
  for (const part of dir.split("/").filter(Boolean)) {
    cur += "/" + part;
    try {
      await sys.mkdir(cur);
    } catch {
      /* exists */
    }
  }
}

// ---- args ------------------------------------------------------------------
const args = sys.argv.slice(1);
let url = null;
let outFile = null;
let remoteName = false;
let showError = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-o" || a === "--output") outFile = args[++i];
  else if (a === "-O" || a === "--remote-name") remoteName = true;
  else if (a === "-s" || a === "--silent") showError = false;
  else if (a === "-S" || a === "--show-error") showError = true;
  else if (a === "-L" || a === "--location") {
    /* fetch follows redirects by default */
  } else if (!a.startsWith("-")) url = a;
}

if (!url) {
  err("curl: no URL specified\nusage: curl [-o file | -O] <url>\n");
  sys.exit(2);
}

try {
  const res = await fetch(url, { mode: "cors", redirect: "follow" });
  if (!res.ok) {
    err("curl: (" + res.status + ") " + res.statusText + " for " + url + "\n");
    sys.exit(22);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  if (remoteName && !outFile) {
    outFile = url.split("?")[0].split("/").pop() || "index.html";
  }
  if (outFile) {
    const path = abs(outFile);
    await mkdirp(dirname(path));
    const fd = await sys.open(path, { create: true, truncate: true });
    sys.write(fd, bytes);
    await sys.close(fd);
    err("curl: wrote " + bytes.length + " bytes to " + path + "\n");
  } else {
    out(bytes);
  }
  sys.exit(0);
} catch (e) {
  // A CORS/network failure lands here (opaque to the page for security reasons).
  err("curl: " + (e && e.message ? e.message : e) + "\n");
  if (showError) err("curl: the URL may lack CORS headers (required for cross-origin fetch)\n");
  sys.exit(1);
}
