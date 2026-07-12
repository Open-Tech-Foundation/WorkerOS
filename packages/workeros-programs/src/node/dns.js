// `node:dns` — load-only stub. `fetch` resolves hostnames itself, so nothing on
// the HTTPS-over-fetch path should ever call these. npm's `@npmcli/agent` requires
// `dns.lookup` and `dns.ADDRCONFIG` at load time, so the names must exist; the
// implementations return benign values in case something does call them.

export function createDns() {
  const cbLast = (args) => (typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined);
  // A hostname "resolves" to itself — the real resolution happens inside fetch.
  const lookup = (host, ...rest) => {
    const cb = cbLast(rest);
    if (cb) queueMicrotask(() => cb(null, host, 4));
  };
  const resolveEmpty = (...args) => {
    const cb = cbLast(args);
    if (cb) queueMicrotask(() => cb(null, []));
  };
  const dns = {
    lookup,
    lookupService: (...args) => { const cb = cbLast(args); if (cb) queueMicrotask(() => cb(null, "localhost", 0)); },
    resolve: resolveEmpty,
    resolve4: resolveEmpty,
    resolve6: resolveEmpty,
    resolveCname: resolveEmpty,
    resolveMx: resolveEmpty,
    resolveNs: resolveEmpty,
    resolveTxt: resolveEmpty,
    resolveSrv: resolveEmpty,
    resolveSoa: (...args) => { const cb = cbLast(args); if (cb) queueMicrotask(() => cb(null, {})); },
    reverse: resolveEmpty,
    getServers: () => [],
    setServers: () => {},
    setDefaultResultOrder: () => {},
    getDefaultResultOrder: () => "verbatim",
    ADDRCONFIG: 0,
    V4MAPPED: 0,
    ALL: 0,
    NODATA: "ENODATA",
    Resolver: class Resolver {},
    promises: {
      lookup: async (host) => ({ address: host, family: 4 }),
      resolve: async () => [],
      resolve4: async () => [],
      resolve6: async () => [],
      reverse: async () => [],
      getServers: () => [],
      setServers: () => {},
      Resolver: class Resolver {},
    },
  };
  dns.default = dns;
  return dns;
}
