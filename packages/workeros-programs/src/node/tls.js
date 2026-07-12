// `node:tls` — load-only stub. The browser cannot open raw TLS sockets, and
// WorkerOS routes outbound HTTPS through `fetch` (see `node:https`), so npm's
// `@npmcli/agent` never actually reaches its `tls.connect` path — our
// `https.request` ignores the agent and lets `fetch` own the connection.
//
// These names exist only so the fetch stack (@npmcli/agent, agent-base, the proxy
// agents) loads and constructs its agents. `connect`/`createServer` throw if truly
// invoked — a loud signal that the fetch-bypass assumption was violated, rather
// than a silent hang.

export function createTls(EventEmitter) {
  const unsupported = (what) => () => {
    throw new Error(`node:tls ${what} is not supported in WorkerOS (HTTPS rides fetch)`);
  };
  const tls = {
    connect: unsupported("sockets (tls.connect)"),
    createServer: unsupported("createServer"),
    TLSSocket: class TLSSocket extends EventEmitter {},
    Server: class Server extends EventEmitter {},
    SecureContext: class SecureContext {},
    createSecureContext: (opts) => ({ ...opts }),
    createSecurePair: unsupported("createSecurePair"),
    checkServerIdentity: () => undefined,
    getCiphers: () => [],
    rootCertificates: [],
    DEFAULT_ECDH_CURVE: "auto",
    DEFAULT_MIN_VERSION: "TLSv1.2",
    DEFAULT_MAX_VERSION: "TLSv1.3",
    DEFAULT_CIPHERS: "",
    constants: { SSL_OP_ALL: 0 },
  };
  tls.default = tls;
  return tls;
}
