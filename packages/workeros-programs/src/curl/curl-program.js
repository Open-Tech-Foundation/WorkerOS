// `curl` — transfer a URL over HTTP(S). A guest program (INV-1), installed at
// /bin/curl and run from wsh. It uses the worker's `fetch` (ADR-008: outbound
// fetch to a CORS-enabled host) and streams bytes through the `sys` ABI, so you
// can pull a wasm binary and run it, POST to a JSON API, send headers, etc.:
//
//   curl -o /hello.wasm https://example.com/hello.wasm
//   /hello.wasm
//   curl -sS -H 'Accept: application/json' https://api.example.com/thing
//   curl -X POST -d '{"a":1}' -H 'Content-Type: application/json' https://api…
//
// The transport is browser `fetch`, so its limits are curl's limits here (INV-5):
// cross-origin URLs must send CORS headers; forbidden request headers (Host,
// Cookie, User-Agent, Referer, …) are dropped by the browser; Set-Cookie and
// unexposed response headers are invisible; there are no raw sockets, no non-HTTP
// protocols, and no TLS/redirect-chain introspection. Everything `fetch` can
// express, curl exposes; nothing it can't.
//
// Authored as a top-level-await ESM program so it can share the guest argv helper.

import { ArgError, tokenizeArgv } from "/lib/workeros-cli/args.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const out = (bytes) => sys.write(1, bytes);
const outStr = (s) => sys.write(1, enc.encode(s));
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

// Read a whole VFS file as bytes (used by -d @file / --data-binary @file / -T).
async function readFile(path) {
  const fd = await sys.open(abs(path), {});
  const chunks = [];
  try {
    for (;;) {
      const b = await sys.read(fd, 1 << 16);
      if (!b || b.length === 0) break;
      chunks.push(b);
    }
  } finally {
    await sys.close(fd);
  }
  let n = 0;
  for (const c of chunks) n += c.length;
  const buf = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return buf;
}

// ---- option table ----------------------------------------------------------
// Short flags that consume a value; every other short flag is boolean. Long
// options are matched by full name below (both `--opt val` and `--opt=val`).
const SHORT_VALUE = new Set(["X", "H", "d", "F", "o", "u", "A", "e", "m", "w", "T", "b"]);
const SHORT_ALIAS = {
  X: "request", H: "header", d: "data", F: "form", o: "output", O: "remote-name",
  u: "user", A: "user-agent", e: "referer", m: "max-time", w: "write-out",
  T: "upload-file", b: "cookie", s: "silent", S: "show-error", L: "location",
  I: "head", i: "include", f: "fail", G: "get", k: "insecure", v: "verbose",
};

// ---- parse args ------------------------------------------------------------
const opts = {
  urls: [],
  method: null,
  headers: [], // [name, value]
  data: [], // {type:'raw'|'urlencode', value:Uint8Array|string}
  form: [], // [name, value] (multipart)
  output: null,
  remoteName: false,
  user: null,
  userAgent: null,
  referer: null,
  maxTime: 0,
  writeOut: null,
  uploadFile: null,
  cookie: null,
  silent: false,
  showError: false,
  head: false,
  include: false,
  fail: false,
  get: false,
  progress: false,
  verbose: false,
};

function setLong(name, getVal) {
  switch (name) {
    case "request": opts.method = getVal(); break;
    case "header": opts.headers.push(splitHeader(getVal())); break;
    case "data": case "data-ascii": opts.data.push({ type: "raw", value: getVal() }); break;
    case "data-raw": opts.data.push({ type: "raw", value: getVal(), raw: true }); break;
    case "data-binary": opts.data.push({ type: "binary", value: getVal() }); break;
    case "data-urlencode": opts.data.push({ type: "urlencode", value: getVal() }); break;
    case "form": case "form-string": opts.form.push(splitForm(getVal())); break;
    case "output": opts.output = getVal(); break;
    case "remote-name": opts.remoteName = true; break;
    case "user": opts.user = getVal(); break;
    case "user-agent": opts.userAgent = getVal(); break;
    case "referer": opts.referer = getVal(); break;
    case "max-time": opts.maxTime = parseFloat(getVal()); break;
    case "connect-timeout": opts.maxTime = opts.maxTime || parseFloat(getVal()); break;
    case "write-out": opts.writeOut = getVal(); break;
    case "upload-file": opts.uploadFile = getVal(); break;
    case "cookie": opts.cookie = getVal(); break;
    case "silent": opts.silent = true; break;
    case "show-error": opts.showError = true; break;
    case "location": break; // fetch follows redirects by default
    case "head": opts.head = true; break;
    case "include": opts.include = true; break;
    case "fail": opts.fail = true; break;
    case "get": opts.get = true; break;
    case "insecure": break; // the browser owns TLS; no-op
    case "compressed": break; // the browser negotiates encoding; no-op
    case "progress-bar": opts.progress = true; break;
    case "verbose": opts.verbose = true; break;
    case "url": opts.urls.push(getVal()); break;
    default:
      err("curl: option --" + name + ": is unknown\n");
      sys.exit(2);
  }
}

function splitHeader(h) {
  const i = h.indexOf(":");
  if (i < 0) return [h.trim(), ""]; // `-H "X-Foo;"` style empty header
  return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
}
function splitForm(f) {
  const i = f.indexOf("=");
  if (i < 0) return [f, ""];
  return [f.slice(0, i), f.slice(i + 1)];
}

try {
  for (const tok of tokenizeArgv(sys.argv.slice(1), { shortAlias: SHORT_ALIAS, shortValue: SHORT_VALUE })) {
    if (tok.kind === "operand") {
      opts.urls.push(tok.value);
      continue;
    }
    if (tok.kind !== "option") continue;
    if (!tok.long && !SHORT_ALIAS[tok.short]) {
      err("curl: option -" + tok.short + ": is unknown\n");
      sys.exit(2);
    }
    setLong(tok.name, () => tok.value);
  }
} catch (e) {
  if (e instanceof ArgError) {
    err("curl: " + e.message + "\n");
    sys.exit(e.exitCode);
  }
  throw e;
}

if (opts.urls.length === 0) {
  err("curl: no URL specified\nusage: curl [options] <url>\n");
  sys.exit(2);
}

// ---- build the request -----------------------------------------------------
function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function buildBody() {
  // Multipart form → FormData (browser sets the multipart Content-Type/boundary).
  if (opts.form.length) {
    const fd = new FormData();
    for (const [name, value] of opts.form) {
      if (value.startsWith("@")) {
        const path = value.slice(1);
        const bytes = await readFile(path);
        fd.append(name, new Blob([bytes]), path.split("/").pop());
      } else {
        fd.append(name, value);
      }
    }
    return { body: fd, contentType: null };
  }

  // -T/--upload-file → raw file body (PUT by default).
  if (opts.uploadFile) {
    return { body: await readFile(opts.uploadFile), contentType: null };
  }

  if (opts.data.length) {
    const parts = [];
    let anyBinary = false;
    for (const d of opts.data) {
      if (d.type === "urlencode") {
        // name=content or =content or @file — content gets URL-encoded.
        let name = "", content = d.value;
        const eq = d.value.indexOf("=");
        if (eq >= 0) { name = d.value.slice(0, eq); content = d.value.slice(eq + 1); }
        if (content.startsWith("@")) content = dec.decode(await readFile(content.slice(1)));
        const encoded = encodeURIComponent(content);
        parts.push(name ? name + "=" + encoded : encoded);
        continue;
      }
      let value = d.value;
      if (typeof value === "string" && value.startsWith("@") && !d.raw) {
        const bytes = await readFile(value.slice(1));
        // --data strips newlines from @file; --data-binary keeps them verbatim.
        if (d.type === "binary") { parts.push(bytes); anyBinary = true; }
        else parts.push(dec.decode(bytes).replace(/[\r\n]/g, ""));
      } else {
        parts.push(value);
      }
    }
    let body;
    if (anyBinary) {
      // Concatenate mixed string/byte parts into one buffer.
      const bufs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
      let n = 0; for (const b of bufs) n += b.length;
      body = new Uint8Array(n);
      let off = 0; for (const b of bufs) { body.set(b, off); off += b.length; }
    } else {
      body = parts.join("&");
    }
    return { body, contentType: "application/x-www-form-urlencoded" };
  }

  return { body: null, contentType: null };
}

// Warn once about request headers the browser silently refuses to send.
const FORBIDDEN = /^(host|cookie|user-agent|referer|origin|connection|content-length|accept-encoding|accept-charset|proxy-|sec-|date|dnt|expect|keep-alive|te|trailer|transfer-encoding|upgrade|via)/i;

async function run(rawUrl) {
  let url = rawUrl;
  const { body, contentType } = await buildBody();

  const headers = new Headers();
  let sawContentType = false;
  for (const [name, value] of opts.headers) {
    if (/^content-type$/i.test(name)) sawContentType = true;
    if (value === "" && !name.includes(":")) {
      // `-H "X-Foo;"` means "send empty header"; a bare name means "remove".
      if (name.endsWith(";")) headers.set(name.slice(0, -1), "");
      continue;
    }
    if (FORBIDDEN.test(name) && !opts.silent) {
      err("curl: warning: the browser will drop the forbidden header '" + name + "'\n");
    }
    headers.append(name, value);
  }
  if (contentType && !sawContentType) headers.set("Content-Type", contentType);
  if (opts.user) headers.set("Authorization", "Basic " + b64(enc.encode(opts.user)));
  if (opts.cookie && opts.cookie.includes("=")) headers.set("Cookie", opts.cookie);
  if (opts.userAgent) headers.set("User-Agent", opts.userAgent); // usually dropped
  if (opts.referer) headers.set("Referer", opts.referer); // usually dropped

  // -G moves data onto the query string instead of the body.
  let sendBody = body;
  if (opts.get && body != null) {
    const qs = typeof body === "string" ? body : dec.decode(body);
    url += (url.includes("?") ? "&" : "?") + qs;
    sendBody = null;
  }

  // Method: explicit -X wins; else HEAD for -I, PUT for -T, POST for a body, GET.
  let method = opts.method;
  if (!method) {
    if (opts.head) method = "HEAD";
    else if (opts.uploadFile) method = "PUT";
    else if (sendBody != null) method = "POST";
    else method = "GET";
  }

  const init = { method, headers, redirect: "follow", mode: "cors" };
  if (sendBody != null && method !== "GET" && method !== "HEAD") init.body = sendBody;

  let signal, timer;
  if (opts.maxTime > 0 && typeof AbortController !== "undefined") {
    const ac = new AbortController();
    signal = ac.signal;
    init.signal = signal;
    timer = setTimeout(() => ac.abort(), opts.maxTime * 1000);
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, init);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // -f/--fail: no output, exit 22 on HTTP >= 400 (curl semantics).
  if (opts.fail && res.status >= 400) {
    if (opts.showError || !opts.silent)
      err("curl: (22) The requested URL returned error: " + res.status + " " + res.statusText + "\n");
    return { res, code: 22, size: 0, t0 };
  }

  // Status line + response headers for -i/-I (and HEAD has no body to print).
  if (opts.include || opts.head) {
    outStr("HTTP/1.1 " + res.status + " " + res.statusText + "\r\n");
    for (const [k, v] of res.headers.entries()) outStr(k + ": " + v + "\r\n");
    outStr("\r\n");
  }

  // Resolve the output sink.
  let outFile = opts.output;
  if (opts.remoteName && !outFile) {
    outFile = url.split("?")[0].split("/").pop() || "index.html";
  }
  const toStdout = !outFile || outFile === "-";

  let fd = -1;
  if (!toStdout) {
    const path = abs(outFile);
    await mkdirp(dirname(path));
    fd = await sys.open(path, { create: true, truncate: true });
  }

  let received = 0;
  const total = Number(res.headers.get("content-length") || 0);
  const showProgress = opts.progress && !opts.silent && !toStdout;

  if (!opts.head && res.body && typeof res.body.getReader === "function") {
    // Stream: don't buffer the whole response in memory.
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
      if (toStdout) out(value);
      else sys.write(fd, value);
      if (showProgress && total > 0) {
        const pct = Math.floor((received / total) * 100);
        const bar = "#".repeat(Math.floor(pct / 2)).padEnd(50, " ");
        err("\r" + String(pct).padStart(3) + "% [" + bar + "] " + received + "/" + total);
      }
    }
    if (showProgress) err("\n");
  } else if (!opts.head) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    received = bytes.length;
    if (toStdout) out(bytes);
    else sys.write(fd, bytes);
  }

  if (fd >= 0) {
    await sys.close(fd);
    if (!opts.silent && !opts.progress)
      err("curl: wrote " + received + " bytes to " + abs(outFile) + "\n");
  }

  return { res, code: 0, size: received, t0 };
}

// %{...} write-out interpolation (the useful subset).
function writeOutStr(fmt, res, size, t0) {
  const vars = {
    http_code: res.status,
    response_code: res.status,
    size_download: size,
    content_type: res.headers.get("content-type") || "",
    url_effective: res.url,
    time_total: ((Date.now() - t0) / 1000).toFixed(6),
    num_headers: [...res.headers.keys()].length,
  };
  return fmt
    .replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r")
    .replace(/%\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
    .replace(/%%/g, "%");
}

// ---- drive every URL -------------------------------------------------------
let exitCode = 0;
for (const rawUrl of opts.urls) {
  try {
    const { res, code, size, t0 } = await run(rawUrl);
    if (code !== 0) { exitCode = code; continue; }
    if (opts.writeOut) outStr(writeOutStr(opts.writeOut, res, size, t0));
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    const msg = timedOut
      ? "curl: (28) Operation timed out after " + opts.maxTime + " seconds\n"
      : "curl: (" + ((e && e.message) || e) + ")\n";
    if (opts.showError || !opts.silent) {
      err(msg);
      if (opts.showError && !timedOut)
        err("curl: the URL may lack CORS headers (required for cross-origin fetch)\n");
    }
    exitCode = timedOut ? 28 : exitCode || 1;
  }
}

sys.exit(exitCode);
