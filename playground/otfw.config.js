// Minimal OTF Web config for the playground host app. `otfw dev` serves app/ with
// HMR; the preview-sw.js service worker (registered in index.html) grants the
// cross-origin isolation the kernel needs in local dev.
export default {
  site: { url: "http://localhost" },
};
