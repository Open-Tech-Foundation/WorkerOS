// Canonical classifier for official Node.js test files. Shared by the raw runner
// (node-compat-full.mjs) and the website report generator (node-compat-report.mjs)
// so both bucket every test identically.
//
// Two axes are returned:
//   suite  - the upstream top-level test directory (parallel, sequential, wasi...)
//   module - the Node.js subsystem the test exercises, normalized to a canonical
//            builtin where possible. Genuine one-off feature tests that do not map
//            to a public builtin collapse into "misc" rather than 90 single-file
//            buckets.

// Canonical builtin/subsystem prefixes as they appear in `test-<prefix>-*` names.
// Matched longest-first so e.g. "http2" wins over "http".
const CANONICAL = [
  "async-hooks", "child-process", "diagnostics-channel", "perf-hooks",
  "string-decoder", "trace-events", "test-runner", "worker", "webstreams",
  "webcrypto", "permission", "inspector", "punycode", "querystring", "readline",
  "process", "cluster", "console", "crypto", "buffer", "stream", "assert",
  "events", "module", "domain", "timers", "http2", "https", "sqlite", "dgram",
  "http", "path", "repl", "zlib", "wasi", "dns", "net", "tls", "tty", "url",
  "util", "vm", "os", "v8", "fs", "whatwg", "errors", "cli", "quic",
];

// Non-obvious topics that clearly belong to a canonical builtin. Keys are matched
// as `test-<key>` exactly or `test-<key>-*`.
const ALIASES = {
  // http/2
  h2: "http2", h2leak: "http2", client: "http", outgoing: "http",
  // dns
  c: "dns", // c-ares
  // worker_threads / structured messaging
  messagechannel: "worker", messageevent: "worker", messageport: "worker",
  messaging: "worker", broadcastchannel: "worker", experimental: "worker",
  // events / AbortSignal / EventTarget
  eventemitter: "events", eventtarget: "events", nodeeventtarget: "events",
  emit: "events", abortsignal: "events", abortcontroller: "events",
  aborted: "events", asyncresource: "async-hooks",
  // buffer / encoding globals
  btoa: "buffer", atob: "buffer", blob: "buffer", stringbytes: "buffer",
  utf8: "buffer", bad: "buffer", // bad-unicode
  // url / whatwg
  data: "url", fileurltopathbuffer: "url",
  // util
  parse: "util", sys: "util", validators: "util", inspect: "util",
  // crypto
  x509: "crypto", dsa: "crypto", strace: "crypto", // strace-openat-openssl
  // fetch/undici surface
  fetch: "fetch", websocket: "fetch", eventsource: "fetch", webstream: "webstreams",
  compression: "webstreams",
  // process lifecycle / flags
  beforeexit: "process", deprecation: "process", pending: "process",
  setproctitle: "process", sigint: "process", kill: "process", init: "process",
  dummy: "process", safe: "process", resource: "process", uncaught: "process",
  unhandled: "process", warn: "process", ref: "timers", primitive: "timers",
  // v8 / heap / startup
  get: "v8", write: "v8", heapdump: "v8", heapsnapshot: "v8", heap: "v8",
  cppheap: "v8", max: "v8", code: "v8", snapshot: "v8", startup: "v8",
  bootstrap: "v8",
  // module resolution
  directory: "module", find: "module", delayed: "module", vfs: "module",
  resolution: "inspector",
  // intl
  tz: "intl", icu: "intl", datetime: "intl", intl: "intl",
  // net
  socketaddress: "net", blocklist: "net", destroy: "net", socket: "net",
  js: "net", // js-stream
  // stream
  streams: "stream", readable: "stream",
  // child_process
  spawn: "child-process",
  // perf_hooks
  perf: "perf-hooks", tojson: "perf-hooks", performanceobserver: "perf-hooks",
  performance: "perf-hooks",
  // tracing
  tracing: "trace-events",
  // fs
  watch: "fs",
  // cli / startup flags
  bash: "cli", corepack: "cli", options: "cli", unicode: "cli",
  security: "cli", preload: "cli", dotenv: "cli", disable: "cli",
  // globals
  navigator: "global", global: "global", webstorage: "global",
  // test runner
  runner: "test-runner",
  // events / promises
  event: "events", promise: "promise", promises: "promise", async: "async-hooks",
  // module resolution
  require: "module",
  // stream family
  stream2: "stream", stream3: "stream", streams2: "stream", pipe: "net",
  tcp: "net", listen: "net",
  // vm / compile / shadowrealm
  compile: "vm", shadow: "vm", eval: "vm",
  // v8 profiling / gc
  cpu: "v8", gc: "v8",
  // inspector / debugger
  debugger: "inspector", debug: "inspector",
  // process stdio / signals / lifecycle
  stdin: "process", stdout: "process", stdio: "process", signal: "process",
  next: "process", // next-tick
  // node internals (not public API; kept distinct so they don't inflate a builtin)
  internal: "internal", primordials: "internal", uv: "internal", wrap: "internal",
  // node tooling tests (lint of Node's own tools, not runtime behavior)
  eslint: "tooling", doctool: "tooling", node: "tooling", common: "tooling",
  // trace
  trace: "trace-events",
  // remaining clearly-attributable one-offs
  file: "buffer", filehandle: "fs", esm: "es-module", source: "module",
  microtask: "process", exception: "process", env: "process", cwd: "process",
  mime: "util", openssl: "crypto", ttywrap: "tty", domexception: "errors",
  error: "errors", tick: "v8", handle: "net", config: "cli", force: "cli",
};

// Upstream suite directories that ARE their own subsystem and need no per-file
// classification (their directory name is the module).
const SUITE_AS_MODULE = new Set([
  "async-hooks", "benchmark", "es-module", "internet", "known_issues",
  "module-hooks", "pseudo-tty", "pummel", "report", "sea", "wasi", "wpt",
  "client-proxy", "system-ca", "tick-processor", "doctool", "abort",
  "v8-updates", "embedding", "wasm-allocation", "test426", "common", "fixtures",
]);

export function classify(file) {
  const slash = file.indexOf("/");
  const suite = slash === -1 ? file : file.slice(0, slash);
  const basename = slash === -1 ? file : file.slice(slash + 1);

  if (suite !== "parallel" && suite !== "sequential") {
    return { suite, module: SUITE_AS_MODULE.has(suite) ? suite : suite };
  }

  const name = basename.replace(/^test-/, "").replace(/\.(?:js|mjs|cjs)$/, "");
  const canonical = CANONICAL.find((p) => name === p || name.startsWith(p + "-"));
  if (canonical) return { suite, module: canonical };

  const head = name.split("-")[0];
  if (ALIASES[head]) return { suite, module: ALIASES[head] };

  return { suite, module: "misc" };
}

// Back-compat helper matching the old moduleFor() signature.
export function moduleFor(file) {
  return classify(file).module;
}
