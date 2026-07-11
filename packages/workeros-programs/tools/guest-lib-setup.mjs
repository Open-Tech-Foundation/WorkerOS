// Test preload (`node --import`): guest programs import their shared runtime from
// absolute VFS paths (`/lib/workeros-<seg>/<file>`) that the kernel resolver +
// blob stitch turn into real modules at boot. `node --test` has no kernel, so a
// unit test that imports a guest program (e.g. nano's pure text helpers) would
// choke on those specifiers. Map them back to their source files by the same
// convention the boot image installs them under: `/lib/workeros-<seg>/<rest>` is
// installed from `src/<seg>/<rest>` (see `libraries` in src/index.js).
import module from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PREFIX = "/lib/workeros-";

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(PREFIX)) {
      const rest = specifier.slice(PREFIX.length); // e.g. "cli/args.js"
      const real = join(srcDir, rest);
      return { url: pathToFileURL(real).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
