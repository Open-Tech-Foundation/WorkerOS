// Durable filesystem storage (ADR-022).
//
// The kernel's in-memory tree is authoritative; persistence is a *projection* of
// its durable subtrees. The kernel serializes that projection to an opaque byte
// blob (`kernel.snapshot()`), and this module is the dumb store that shuttles
// the blob to and from IndexedDB — it never inspects or decides anything (the
// ADR-015/-020 "Rust decides, the host supplies the mechanism" discipline).
//
// Layout: one database, one object store, one row — the whole durable tree as a
// single value keyed by SNAPSHOT_KEY. Snapshots are small (source files, not the
// ephemeral `/tmp` + `node_modules` bulk, which the kernel prunes before we ever
// see the bytes), so a single-blob store is simpler than per-file rows and keeps
// writes atomic. Per-file keying is a future optimization if snapshots grow.

const DB_NAME = "workeros";
const DB_VERSION = 1;
const STORE = "fs";
const SNAPSHOT_KEY = "snapshot";

/** Open (creating/upgrading) the WorkerOS IndexedDB database. */
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * A persistence handle bound to an open database. `load()` returns the stored
 * snapshot bytes (or null on a first run); `save(bytes)` overwrites them.
 * Degrades gracefully: if IndexedDB can't be opened (private mode, disabled),
 * `open()` returns a no-op store so the OS still runs, just without durability.
 */
export async function openPersistence() {
  let db = null;
  try {
    db = await openDb();
  } catch (err) {
    console.warn("[workeros] persistence disabled:", err && err.message);
    return {
      available: false,
      async load() {
        return null;
      },
      async save() {},
    };
  }
  return {
    available: true,
    async load() {
      const v = await tx(db, "readonly", (s) => s.get(SNAPSHOT_KEY));
      if (v == null) return null;
      return v instanceof Uint8Array ? v : new Uint8Array(v);
    },
    async save(bytes) {
      await tx(db, "readwrite", (s) => s.put(bytes, SNAPSHOT_KEY));
    },
    async clear() {
      await tx(db, "readwrite", (s) => s.delete(SNAPSHOT_KEY));
    },
  };
}
