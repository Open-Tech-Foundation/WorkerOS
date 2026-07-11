// A ZIP reader/writer — the container under `/bin/zip` and `/bin/unzip`.
//
// GUEST library (INV-1), installed at /lib/workeros-archive/zip.js. Pure
// bytes-in/bytes-out (no `sys`), so it is unit-testable and cross-checkable
// against real `zip`/`unzip`. The DEFLATE payload (method 8) + CRC-32 come from a
// `codec` the caller passes in (node:zlib's `crc32`/`deflateRawSync`/
// `inflateRawSync`) — injected rather than imported so this lib carries no path
// coupling to the node tree (the two live in different /lib subdirs). Stores
// (method 0) when compression doesn't help. Writes local file headers + a central
// directory + EOCD; reads by walking the central directory.

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

// MS-DOS packed date/time (local time, 2-second resolution) for a ms timestamp.
function dosDateTime(ms) {
  const d = new Date(ms ?? Date.now());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}
function fromDosDateTime(time, date) {
  const sec = (time & 0x1f) * 2;
  const min = (time >> 5) & 0x3f;
  const hour = (time >> 11) & 0x1f;
  const day = date & 0x1f;
  const month = ((date >> 5) & 0x0f) - 1;
  const year = ((date >> 9) & 0x7f) + 1980;
  return new Date(year, month, day, hour, min, sec).getTime();
}

/**
 * Build a ZIP from entries `{ name, type: "file"|"dir", data?, mtime? }`.
 * Directory entries carry a trailing "/". `codec` supplies `crc32` +
 * `deflateRawSync` (node:zlib). Returns a `Uint8Array`.
 */
export function createZip(entries, codec) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const isDir = e.type === "dir" || e.name.endsWith("/");
    const name = isDir && !e.name.endsWith("/") ? e.name + "/" : e.name;
    const nameBytes = enc.encode(name);
    const raw = isDir ? new Uint8Array(0) : e.data || new Uint8Array(0);
    const crc = codec.crc32(raw);
    const { time, date } = dosDateTime(e.mtime);

    let method = 0;
    let stored = raw;
    if (!isDir && raw.length > 0) {
      const deflated = codec.deflateRawSync(raw);
      if (deflated.length < raw.length) { method = 8; stored = deflated; }
    }

    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true); // local file header signature
    ldv.setUint16(4, 20, true);         // version needed
    ldv.setUint16(6, 0, true);          // flags
    ldv.setUint16(8, method, true);
    ldv.setUint16(10, time, true);
    ldv.setUint16(12, date, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, stored.length, true);
    ldv.setUint32(22, raw.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);         // extra len
    lh.set(nameBytes, 30);
    chunks.push(lh, stored);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true); // central directory header signature
    cdv.setUint16(4, 0x031e, true);     // version made by (UNIX, v3.0)
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, time, true);
    cdv.setUint16(14, date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, stored.length, true);
    cdv.setUint32(24, raw.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);         // extra
    cdv.setUint16(32, 0, true);         // comment
    cdv.setUint16(34, 0, true);         // disk number
    cdv.setUint16(36, 0, true);         // internal attrs
    cdv.setUint32(38, (isDir ? 0o40755 : 0o100644) << 16 | (isDir ? 0x10 : 0), true); // ext attrs: UNIX mode + DOS dir bit
    cdv.setUint32(42, offset, true);    // local header offset
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + stored.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; }

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, entries.length, true);  // entries on this disk
  edv.setUint16(10, entries.length, true); // total entries
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdStart, true);
  chunks.push(eocd);

  return concat(chunks);
}

/** Parse a ZIP into entries `{ name, type, data, mtime, crc, size }`. `codec`
 * supplies `crc32` + `inflateRawSync` (node:zlib). */
export function parseZip(bytes, codec) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find the End Of Central Directory record (scan back over its variable comment).
  let eo = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  }
  if (eo < 0) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = dv.getUint16(eo + 10, true);
  let p = dv.getUint32(eo + 16, true);
  const entries = [];
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const time = dv.getUint16(p + 12, true);
    const date = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);

    const isDir = name.endsWith("/");
    let data = new Uint8Array(0);
    if (!isDir) {
      if (method === 0) data = comp.slice();
      else if (method === 8) data = codec.inflateRawSync(comp);
      else throw new Error(`unsupported zip compression method ${method} for ${name}`);
      if (codec.crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    }
    entries.push({
      name: name.replace(/\/$/, ""),
      type: isDir ? "dir" : "file",
      data,
      mtime: fromDosDateTime(time, date),
      crc,
      size: uncompSize,
    });
  }
  return entries;
}
