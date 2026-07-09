// workeros-npm — the `npm` guest program for WorkerOS.
//
// The program is authored as a plain top-level-await script in `npm-program.js`
// (so it can be linted/formatted normally). The host installs its *text* into the
// VFS at `/bin/npm` on boot; there is no build step. Because a guest program is
// standalone source (not a module the host imports), we hand back the source text
// rather than the module's exports.

/** The VFS path the program is installed at. */
export const NPM_BIN = "/bin/npm";

/** Fetch the `npm` program source text (same-origin) for installation into /bin. */
export async function npmSource() {
  const url = new URL("./npm-program.js", import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`npmSource: ${url} -> HTTP ${res.status}`);
  return res.text();
}
