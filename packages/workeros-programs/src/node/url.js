// `node:url` — URL helpers for the WorkerOS Node runtime.
//
// GUEST code (INV-1). Re-exports the platform WHATWG `URL`/`URLSearchParams`
// (available on the worker global) and adds Node's file-URL ⇄ path helpers plus
// the legacy `url.parse`/`format`/`resolve`. WorkerOS has one posix VFS, so a
// file-URL host is only ever empty or "localhost". Pure — unit-testable on its own.

const stripQ = (search) => (search && search.startsWith("?") ? search.slice(1) : search || null);
const queryToObj = (search) => {
  const obj = {};
  for (const [k, v] of new URLSearchParams(search || "")) {
    if (k in obj) obj[k] = [].concat(obj[k], v);
    else obj[k] = v;
  }
  return obj;
};

export function createUrl() {
  // file:// URL → posix path. Percent-decoded; host must be empty/localhost.
  const fileURLToPath = (u) => {
    const url = typeof u === "string" ? new URL(u) : u;
    if (url.protocol !== "file:") throw new TypeError("The URL must be of scheme file");
    if (url.hostname && url.hostname !== "localhost") {
      throw new TypeError('File URL host must be "localhost" or empty on WorkerOS');
    }
    return decodeURIComponent(url.pathname) || "/";
  };

  // posix path → file:// URL object. WHATWG URL percent-encodes as needed.
  const pathToFileURL = (p) => {
    const u = new URL("file://");
    u.pathname = p.startsWith("/") ? p : "/" + p;
    return u;
  };

  // Legacy `url.parse` → a subset of the classic urlObject, built on WHATWG URL.
  const parse = (input, parseQueryString = false) => {
    let u = null;
    try {
      u = new URL(input);
    } catch {
      u = null;
    }
    if (!u) {
      // Relative / path-only input: fill what we can, leave the network parts null.
      const hashIdx = input.indexOf("#");
      const hash = hashIdx === -1 ? null : input.slice(hashIdx);
      const rest = hashIdx === -1 ? input : input.slice(0, hashIdx);
      const qIdx = rest.indexOf("?");
      const pathname = (qIdx === -1 ? rest : rest.slice(0, qIdx)) || null;
      const search = qIdx === -1 ? null : rest.slice(qIdx);
      return {
        protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null,
        hash, search,
        query: parseQueryString ? queryToObj(search) : stripQ(search),
        pathname,
        path: pathname || search ? (pathname || "") + (search || "") : null,
        href: input,
      };
    }
    return {
      protocol: u.protocol,
      slashes: /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || null,
      auth: u.username ? u.username + (u.password ? ":" + u.password : "") : null,
      host: u.host || null,
      port: u.port || null,
      hostname: u.hostname || null,
      hash: u.hash || null,
      search: u.search || null,
      query: parseQueryString ? queryToObj(u.search) : stripQ(u.search),
      pathname: u.pathname || null,
      path: (u.pathname || "") + (u.search || "") || null,
      href: u.href,
    };
  };

  const format = (obj) => {
    if (obj instanceof URL) return obj.href;
    if (typeof obj === "string") return obj;
    let out = "";
    if (obj.protocol) out += obj.protocol.endsWith(":") ? obj.protocol : obj.protocol + ":";
    if (obj.slashes || obj.host || obj.hostname) out += "//";
    if (obj.auth) out += obj.auth + "@";
    out += obj.host || (obj.hostname || "") + (obj.port ? ":" + obj.port : "");
    if (obj.pathname) out += obj.pathname;
    if (obj.search) out += obj.search;
    else if (obj.query && typeof obj.query === "object") {
      const q = new URLSearchParams(obj.query).toString();
      if (q) out += "?" + q;
    } else if (typeof obj.query === "string" && obj.query) {
      out += "?" + obj.query;
    }
    if (obj.hash) out += obj.hash.startsWith("#") ? obj.hash : "#" + obj.hash;
    return out;
  };

  const resolve = (from, to) => {
    try {
      return new URL(to, from).href;
    } catch {
      // Both relative: resolve `to` against `from` as posix-ish paths.
      if (!to || to.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(to)) return to || from;
      const base = from.slice(0, from.lastIndexOf("/") + 1);
      const segs = [];
      for (const part of (base + to).split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") segs.pop();
        else segs.push(part);
      }
      return (from.startsWith("/") ? "/" : "") + segs.join("/");
    }
  };

  return {
    URL,
    URLSearchParams,
    fileURLToPath,
    pathToFileURL,
    parse,
    format,
    resolve,
    domainToASCII: (d) => {
      try {
        return new URL("http://" + d).hostname;
      } catch {
        return "";
      }
    },
    domainToUnicode: (d) => {
      try {
        return decodeURIComponent(new URL("http://" + d).hostname);
      } catch {
        return "";
      }
    },
  };
}
