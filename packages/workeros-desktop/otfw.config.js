// Minimal OTF Web config for the standalone desktop app (no docs/marketing shell —
// unlike the website's otfw.config.js). `otfw dev` serves app/ with HMR; the
// preview-sw.js service worker (registered in index.html) grants cross-origin
// isolation so the kernel's SharedArrayBuffer syscalls work in local dev.
export default {
  site: { url: "http://localhost" },
};
