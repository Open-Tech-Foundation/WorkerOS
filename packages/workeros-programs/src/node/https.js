// `node:https` — outbound HTTPS mapped onto the worker's `fetch`, exactly like
// `node:http` (the browser does TLS/DNS/TCP). This is the module that lets
// `/bin/npm` reach registry.npmjs.org: npm's `minipass-fetch` calls
// `https.request(options)` and streams the response. We reuse http's fetch-backed
// client factory with an `https:` default; npm passes `protocol` explicitly anyway.
//
// Server-side TLS termination isn't available in the sandbox, so `createServer`
// throws — WorkerOS only serves plain HTTP internally.

export function createHttps(EventEmitter, http) {
  const { ClientRequest, request, get } = http.makeClient("https:");
  const https = {
    ClientRequest,
    request,
    get,
    IncomingMessage: http.IncomingMessage,
    STATUS_CODES: http.STATUS_CODES,
    METHODS: http.METHODS,
    globalAgent: {},
    Agent: class Agent extends EventEmitter {},
    createServer() {
      throw new Error("https.createServer is not supported in WorkerOS (no TLS termination; outbound HTTPS uses fetch)");
    },
  };
  https.default = https;
  return https;
}
