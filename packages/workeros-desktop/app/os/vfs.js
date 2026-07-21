// Filesystem foundation for the desktop: the user's home directory, path helpers,
// and a one-time seed of the standard folders so the DE has a real place to live.
// All ops go through the shared kernel client (os.fs.*), so the Terminal and every
// app see the same tree.

import { getOS } from "./os.js";

/** The root user's home directory (WorkerOS runs as root). */
export const HOME = "/root";

/** Standard folders seeded under HOME (like a normal desktop account). */
export const HOME_DIRS = ["Desktop", "Documents", "Downloads"];

// ---- path helpers (POSIX, absolute) ----

export function join(dir, name) {
  if (!name) return dir;
  return (dir === "/" ? "" : dir.replace(/\/+$/, "")) + "/" + name;
}

export function parent(path) {
  if (path === "/" || path === "") return "/";
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function basename(path) {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Show HOME as `~` for a friendlier path label. */
export function displayPath(path) {
  if (path === HOME) return "~";
  if (path.startsWith(HOME + "/")) return "~" + path.slice(HOME.length);
  return path;
}

// ---- one-time home seed ----

let seeded = null;

/** Create HOME and its standard folders once (idempotent; mkdir -p tolerates
 *  pre-existing dirs, and a durable filesystem keeps them across sessions). */
export function seedHome() {
  if (!seeded) {
    seeded = (async () => {
      const os = await getOS();
      await os.fs.mkdir(HOME);
      for (const d of HOME_DIRS) await os.fs.mkdir(join(HOME, d));
      // A friendly starter note, only if Documents is empty.
      try {
        const docs = join(HOME, "Documents");
        const entries = await os.fs.list(docs);
        if (entries.length === 0) {
          await os.fs.write(
            join(docs, "Welcome.txt"),
            "Welcome to WorkerOS.\n\nThis is your home directory on a real kernel " +
              "running in a Web Worker. Open the Terminal and you'll find these same " +
              "files under /root — the desktop and the shell share one filesystem.\n",
          );
        }
      } catch {}
    })();
  }
  return seeded;
}
