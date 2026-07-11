// A dependency-free POSIX ustar reader/writer — the framing under `/bin/tar`.
//
// GUEST library (INV-1), installed at /lib/workeros-archive/tar.js and imported by
// the tar program. Pure bytes-in/bytes-out (no `sys`, no compression — gzip is
// layered on top by the program via node:zlib), so it is fully unit-testable and
// cross-checkable against real `tar`. ustar format: a 512-byte header per member,
// data padded to 512, two zero blocks at the end. Octal ASCII numeric fields.

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Split a >100-char path into ustar prefix[155] + name[100] at a "/" boundary.
function splitName(path) {
  if (enc.encode(path).length <= 100) return { name: path, prefix: "" };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(name).length <= 100 && enc.encode(prefix).length <= 155) return { name, prefix };
  }
  throw new Error(`path too long for tar (ustar): ${path}`);
}

function header(entry) {
  const h = new Uint8Array(512);
  const put = (off, str, len) => { const b = enc.encode(str); h.set(b.subarray(0, Math.min(b.length, len)), off); };
  const putOct = (off, val, len) => put(off, val.toString(8).padStart(len - 1, "0"), len - 1); // NUL-terminated

  const isDir = entry.type === "dir";
  let name = entry.name;
  if (isDir && !name.endsWith("/")) name += "/";
  const { name: n, prefix } = splitName(name);
  put(0, n, 100);
  putOct(100, entry.mode ?? (isDir ? 0o755 : 0o644), 8);
  putOct(108, entry.uid ?? 0, 8);
  putOct(116, entry.gid ?? 0, 8);
  putOct(124, isDir ? 0 : entry.data.length, 12);
  putOct(136, Math.floor((entry.mtime ?? Date.now()) / 1000), 12);
  for (let i = 148; i < 156; i++) h[i] = 0x20; // checksum field = spaces while summing
  h[156] = isDir ? 0x35 : 0x30; // typeflag '5' | '0'
  put(257, "ustar", 6); // magic "ustar\0"
  put(263, "00", 2); // version
  put(265, entry.uname ?? "root", 32);
  put(297, entry.gname ?? "root", 32);
  if (prefix) put(345, prefix, 155);

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  put(148, sum.toString(8).padStart(6, "0"), 6);
  h[154] = 0; h[155] = 0x20; // 6 octal digits, NUL, space
  return h;
}

/**
 * Build a tar archive from entries `{ name, type: "file"|"dir", data?, mode?, mtime? }`.
 * `mtime` is ms since epoch. Returns a `Uint8Array`.
 */
export function createTar(entries) {
  const blocks = [];
  for (const e of entries) {
    blocks.push(header(e));
    if (e.type !== "dir" && e.data && e.data.length) {
      blocks.push(e.data);
      const pad = (512 - (e.data.length % 512)) % 512;
      if (pad) blocks.push(new Uint8Array(pad));
    }
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks terminate the archive
  return concat(blocks);
}

const readStr = (bytes, o, len) => {
  const s = dec.decode(bytes.subarray(o, o + len));
  const z = s.indexOf("\0");
  return z >= 0 ? s.slice(0, z) : s;
};
const readOct = (bytes, o, len) => {
  const s = readStr(bytes, o, len).trim();
  return s ? parseInt(s, 8) || 0 : 0;
};

/** Parse a tar archive into entries `{ name, type, data, mode, mtime }`. */
export function parseTar(bytes) {
  const entries = [];
  let off = 0;
  while (off + 512 <= bytes.length) {
    let zero = true;
    for (let i = 0; i < 512; i++) if (bytes[off + i] !== 0) { zero = false; break; }
    if (zero) break; // end-of-archive marker

    const name = readStr(bytes, off, 100);
    const prefix = readStr(bytes, off + 345, 155);
    const size = readOct(bytes, off + 124, 12);
    const mode = readOct(bytes, off + 100, 8);
    const mtime = readOct(bytes, off + 136, 12) * 1000;
    const typeflag = bytes[off + 156];
    const isDir = typeflag === 0x35 || (name.endsWith("/") && size === 0);
    const full = prefix ? `${prefix}/${name}` : name;

    off += 512;
    let data = null;
    if (!isDir) {
      data = bytes.slice(off, off + size);
      off += size + ((512 - (size % 512)) % 512);
    }
    entries.push({
      name: full.replace(/\/$/, ""),
      type: isDir ? "dir" : "file",
      data,
      mode,
      mtime,
    });
  }
  return entries;
}
