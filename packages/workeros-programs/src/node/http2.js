// `node:http2` — load-only stub. Only npm's sigstore provenance/audit path
// (`@sigstore/sign`) requires it, and never on a plain `npm install`. The names
// exist so that module loads; the entry points throw if actually used.

export function createHttp2() {
  const unsupported = (what) => () => {
    throw new Error(`node:http2 ${what} is not supported in WorkerOS`);
  };
  const http2 = {
    connect: unsupported("connect"),
    createServer: unsupported("createServer"),
    createSecureServer: unsupported("createSecureServer"),
    getDefaultSettings: () => ({}),
    getPackedSettings: () => Buffer.alloc(0),
    getUnpackedSettings: () => ({}),
    constants: {},
    sensitiveHeaders: Symbol("nodejs.http2.sensitiveHeaders"),
  };
  http2.default = http2;
  return http2;
}
