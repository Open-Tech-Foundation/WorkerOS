// Durable filesystem storage: a content-addressed block store (ADR-022).
//
// The kernel's in-memory tree is authoritative; persistence is a *projection* of
// its durable subtrees in the ZFS/git shape. Two things get stored:
//
//   - **chunks**: file data, split by the kernel into content-addressed pieces
//     keyed by SHA-256 (hex). Each is compressed (deflate-raw) and written once —
//     identical chunks dedup, and on each flush only *new* hashes are written
//     (delta). The hash is also an integrity checksum (verified on load).
//   - **meta/manifest**: the durable directory tree + inode metadata + each
//     file's ordered chunk-hash list — the root that ties the chunks together.
//
// This module is the dumb block store: it compresses/decompresses and moves bytes
// by key. All structure and content-addressing decisions are the kernel's (INV-2,
// the ADR-015/-020 discipline). Snapshots + GC layer on top in Stage 4.

const DB_NAME = "workeros";
const DB_VERSION = 2;
const CHUNKS = "chunks";
const META = "meta";
const MANIFEST_KEY = "manifest";

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      // A v1 store (single-blob snapshot) may exist from the pre-CAS format; it
      // is simply ignored — the tree re-materializes from source on first run.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txReq(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function deflate(bytes) {
  const cs = new CompressionStream("deflate-raw");
  const w = cs.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflate(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/**
 * Open the content-addressed block store. Degrades to a no-op store (the OS
 * still runs, without durability) if IndexedDB or Compression Streams are
 * unavailable.
 */
export async function openPersistence() {
  let db = null;
  const usable =
    typeof indexedDB !== "undefined" && typeof CompressionStream !== "undefined";
  if (usable) {
    try {
      db = await openDb();
    } catch (err) {
      console.warn("[workeros] persistence disabled:", err && err.message);
      db = null;
    }
  }
  if (!db) {
    return {
      available: false,
      async loadManifest() {
        return null;
      },
      async saveManifest() {},
      async knownChunks() {
        return new Set();
      },
      async putChunk() {},
      async getChunk() {
        return null;
      },
      async allChunkKeys() {
        return [];
      },
      async deleteChunks() {},
    };
  }
  return {
    available: true,

    async loadManifest() {
      const v = await txReq(db, META, "readonly", (s) => s.get(MANIFEST_KEY));
      if (v == null) return null;
      return v instanceof Uint8Array ? v : new Uint8Array(v);
    },
    async saveManifest(bytes) {
      await txReq(db, META, "readwrite", (s) => s.put(bytes, MANIFEST_KEY));
    },

    /** The set of chunk hashes (hex) already stored — to skip re-writing them. */
    async knownChunks() {
      const keys = await txReq(db, CHUNKS, "readonly", (s) => s.getAllKeys());
      return new Set(keys);
    },
    async allChunkKeys() {
      return await txReq(db, CHUNKS, "readonly", (s) => s.getAllKeys());
    },
    /** Store one chunk (compressed) under its hex hash. */
    async putChunk(hex, bytes) {
      const packed = await deflate(bytes);
      await txReq(db, CHUNKS, "readwrite", (s) => s.put(packed, hex));
    },
    /** Fetch + decompress one chunk by hex hash (null if absent). */
    async getChunk(hex) {
      const packed = await txReq(db, CHUNKS, "readonly", (s) => s.get(hex));
      if (packed == null) return null;
      return await inflate(packed instanceof Uint8Array ? packed : new Uint8Array(packed));
    },
    /** Delete chunks by hex hash (GC of unreferenced blocks). */
    async deleteChunks(hexes) {
      if (!hexes.length) return;
      await txReq(db, CHUNKS, "readwrite", (s) => {
        for (const hex of hexes) s.delete(hex);
        return null;
      });
    },
  };
}
