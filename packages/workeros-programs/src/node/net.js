// `node:net` — TCP-shaped sockets for the WorkerOS Node runtime. GUEST code
// (INV-1): the kernel only moves opaque bytes over a port-keyed loopback socket
// (`otf:net_*`, ADR-021); everything TCP-flavored (Server/Socket, the event
// surface, keep-alive) is assembled here, exactly as Node layers `net` over the
// OS. `http` (and, via it, `ws`) build on this.
//
// A connection is a pair of kernel pipe fds — `rfd` (peer→us) and `wfd`
// (us→peer) — so a Socket is a duplex stream over `sys.read(rfd)` /
// `sys.write(wfd)`. `net_accept` blocks in the kernel worker until a client
// connects (ADR-016), so the accept loop below simply awaits the next one.
//
// Honest surface (INV-5): this is NOT real TCP. There is no `net.connect` to the
// internet (that stays `fetch`, CORS-bound — ADR-008); `net.connect(port)` is a
// same-instance loopback to a listening WorkerOS process. No half-open tuning,
// `setNoDelay`/`setKeepAlive` are no-ops, and addresses are synthetic.

const enc = new TextEncoder();
const toBytes = (chunk, encoding) => {
  if (chunk == null) return new Uint8Array(0);
  if (typeof chunk === "string") return enc.encode(chunk);
  if (chunk instanceof Uint8Array) return chunk; // Buffer is a Uint8Array subclass
  return new Uint8Array(chunk);
};

export function createNet(sys, EventEmitter) {
  const Buffer = globalThis.Buffer;
  const loop = () => globalThis.__workerosLoop; // may be undefined outside /bin/node

  // A duplex byte stream over a connection's two pipe fds. Emits Node's socket
  // events (`data`/`end`/`close`/`error`); `write`/`end` push bytes to the peer.
  class Socket extends EventEmitter {
    constructor(conn, options) {
      super();
      this._rfd = conn ? conn.rfd : -1;
      this._wfd = conn ? conn.wfd : -1;
      this._reading = false;
      this._closed = false;
      this._refd = false;
      this._encoding = null;
      this._writeQueue = [];
      // Node half-close default: when the readable side ends, auto-end the
      // writable side unless allowHalfOpen. This is what lets a finished
      // connection fully close so an idle process can exit (no lingering ref).
      this.allowHalfOpen = !!(options && options.allowHalfOpen);
      this.readable = true;
      this.writable = true;
      this.destroyed = false;
      // `connecting`/`pending` track the pre-connect window Node exposes; an
      // accepted server-side socket (conn present) is already connected.
      this.connecting = false;
      this.pending = !conn;
      this.bytesRead = 0;
      this.bytesWritten = 0;
      // Synthetic address tuple (no real TCP tuple exists — INV-5).
      this.remoteAddress = "127.0.0.1";
      this.remotePort = 0;
      this.remoteFamily = "IPv4";
      this.localAddress = "127.0.0.1";
      this.localPort = 0;
      // Only a socket with a live handle holds the loop open. An unconnected
      // `new net.Socket()` must NOT ref (else a socket that only ever `.end()`s
      // without connecting would pin the process open forever); connect() refs
      // once it has fds.
      if (conn) this._ref();
      // Start pumping once someone is listening for data (Node's flowing mode).
      this.on("newListener", (ev) => {
        if ((ev === "data" || ev === "readable") && !this._reading) this._pump();
      });
    }

    _ref() {
      if (!this._refd) { this._refd = true; loop()?.ref(); }
    }
    _unref() {
      if (this._refd) { this._refd = false; loop()?.unref(); }
    }

    // Drain the read fd, emitting 'data' until EOF, then 'end'/'close'.
    async _pump() {
      if (this._reading || this._rfd < 0) return;
      this._reading = true;
      try {
        for (;;) {
          const bytes = await sys.read(this._rfd, 1 << 16);
          if (this._closed) break;
          if (!bytes || bytes.length === 0) {
            this.readable = false;
            this.emit("end");
            // Default (!allowHalfOpen): the peer's EOF ends our write side too, so
            // the connection fully closes and neither side lingers.
            if (!this.allowHalfOpen && this.writable) this.end();
            break;
          }
          this.bytesRead += bytes.length;
          const buf = Buffer.from(bytes);
          this.emit("data", this._encoding ? buf.toString(this._encoding) : buf);
        }
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      } finally {
        this._reading = false;
        this._finishClose();
      }
    }

    write(chunk, encoding, cb) {
      if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
      if (this.destroyed) { if (cb) queueMicrotask(cb); return false; }
      // Writes issued while still connecting buffer until 'connect', exactly like
      // Node; the callback fires when the buffered bytes are actually written.
      if (this.connecting || this._wfd < 0) {
        this._writeQueue.push({ chunk, encoding, cb });
        return false;
      }
      const bytes = toBytes(chunk, encoding);
      try {
        sys.write(this._wfd, bytes);
      } catch (e) {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
        return false;
      }
      this.bytesWritten += bytes.length;
      if (cb) queueMicrotask(cb);
      return true;
    }

    _flushWrites() {
      const queued = this._writeQueue;
      this._writeQueue = [];
      for (const w of queued) this.write(w.chunk, w.encoding, w.cb);
    }

    setEncoding(encoding) { this._encoding = encoding; return this; }

    // Bytes buffered but not yet handed to the kernel. On a loopback pipe writes
    // are taken immediately, so only pre-connect buffered writes count.
    get bufferSize() {
      let n = 0;
      for (const w of this._writeQueue) n += toBytes(w.chunk, w.encoding).length;
      return n;
    }
    get writableLength() { return this.bufferSize; }

    end(chunk, encoding, cb) {
      if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
      else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
      if (chunk != null) this.write(chunk, encoding);
      this.writable = false;
      // Close our write end so the peer sees EOF; keep reading for its reply.
      if (this._wfd >= 0) { try { sys.close(this._wfd); } catch {} this._wfd = -1; }
      if (cb) queueMicrotask(cb);
      // Drive the read side to EOF so the connection can fully close and release
      // its loop ref, even when nothing is actively consuming data (e.g. a server
      // that only writes a response and ends). Pump is idempotent; if the peer has
      // already gone this reaches EOF immediately.
      if (this.readable && !this._reading && this._rfd >= 0) this._pump();
      // If the read side is already done, this completes the close.
      if (!this._reading && !this.readable) this._finishClose();
      return this;
    }

    destroy(err) {
      if (this.destroyed) return this;
      this.destroyed = true;
      this._closed = true;
      if (this._wfd >= 0) { try { sys.close(this._wfd); } catch {} this._wfd = -1; }
      if (this._rfd >= 0) { try { sys.close(this._rfd); } catch {} this._rfd = -1; }
      if (err) this.emit("error", err);
      this._finishClose();
      return this;
    }

    _finishClose() {
      if (this._closed && this.destroyed) return;
      // Close once both directions are done (write ended, read hit EOF).
      if (this.writable || this.readable) return;
      this._closed = true;
      if (this._rfd >= 0) { try { sys.close(this._rfd); } catch {} this._rfd = -1; }
      this._unref();
      this.emit("close", false);
    }

    // Connect this (pre-connect) socket to a listening port. Mirrors Node's
    // socket.connect(): flips `connecting` on synchronously, resolves the loopback
    // connection async, then emits 'connect', flushes buffered writes, and starts
    // reading. Node calls net.connect(...) through here too.
    connect(port, host, cb) {
      if (typeof port === "object" && port !== null) {
        if (port.allowHalfOpen != null) this.allowHalfOpen = !!port.allowHalfOpen;
        cb = host; host = undefined; port = port.port;
      }
      if (typeof host === "function") { cb = host; host = undefined; }
      if (typeof cb === "function") this.once("connect", cb);
      this.connecting = true;
      this.pending = true;
      this.destroyed = false;
      this._closed = false; // allow reconnecting a socket that previously closed
      this._reading = false;
      this.readable = true;
      this.writable = true;
      this.remotePort = port | 0;
      this._ref();
      (async () => {
        let conn;
        try {
          conn = await sys.netConnect(port | 0);
        } catch (e) {
          this.connecting = false;
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
          return;
        }
        if (this.destroyed) { try { sys.close(conn.rfd); sys.close(conn.wfd); } catch {} return; }
        this._rfd = conn.rfd;
        this._wfd = conn.wfd;
        this.connecting = false;
        this.pending = false;
        this.localPort = port | 0; // synthetic — no real local tuple (INV-5)
        this.emit("connect");
        this._flushWrites();
        if (this.listenerCount("data") || this.listenerCount("readable")) this._pump();
      })();
      return this;
    }

    // Node's abrupt close: on a loopback pipe there is no RST to send, so this is
    // an immediate destroy (the peer sees EOF on its next read — INV-6).
    resetAndDestroy() { return this.destroy(); }

    // Tuning knobs Node exposes that have no meaning on a loopback pipe (INV-5).
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    setTimeout(_ms, cb) { if (cb) this.once("timeout", cb); return this; }
    ref() { this._ref(); return this; }
    unref() { this._unref(); return this; }
    address() { return { address: this.remoteAddress, family: "IPv4", port: this.remotePort }; }
  }

  // A listening socket: claims a port and emits a Socket per inbound connection.
  class Server extends EventEmitter {
    constructor(opts, connectionListener) {
      super();
      if (typeof opts === "function") { connectionListener = opts; opts = {}; }
      this._opts = opts || {};
      this._listener = -1;
      this.listening = false;
      this._refd = false;
      if (connectionListener) this.on("connection", connectionListener);
    }

    listen(port, host, cb) {
      // Node's many listen() arities; we only need the port (+ optional callback).
      if (typeof port === "object" && port !== null) { cb = host; host = undefined; port = port.port; }
      if (typeof host === "function") { cb = host; host = undefined; }
      if (cb) this.once("listening", cb);
      this._port = port | 0;
      // Ref the event loop *synchronously*, before the async netListen: /bin/node
      // checks whenIdle() the moment the script's top level returns, so a deferred
      // ref would let the process exit before the server is even registered (the
      // "node exits immediately" bug). Held until close()/listen error.
      if (!this._refd) { this._refd = true; loop()?.ref(); }
      (async () => {
        try {
          // netListen returns { listener, port }; port is the kernel-assigned
          // ephemeral port when we asked for 0, so address() reports a real port
          // (Node's listen(0) contract — clients dial server.address().port).
          const bound = await sys.netListen(this._port);
          this._listener = bound.listener;
          this._port = bound.port;
        } catch (e) {
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
          if (this._refd) { this._refd = false; loop()?.unref(); }
          return;
        }
        this.listening = true;
        this.emit("listening");
        // Accept loop: awaits the next connection; the kernel parks it for us.
        while (this.listening) {
          let conn;
          try {
            conn = await sys.netAccept(this._listener);
          } catch (e) {
            if (this.listening) this.emit("error", e instanceof Error ? e : new Error(String(e)));
            break;
          }
          if (!this.listening) break;
          const socket = new Socket(conn, this._opts);
          socket.server = this; // Node exposes the owning server on the socket
          this.emit("connection", socket);
        }
      })();
      return this;
    }

    address() { return { address: "127.0.0.1", family: "IPv4", port: this._port }; }

    // A listening server holds the event loop open (like Node); unref() lets the
    // process exit while it keeps listening, ref() re-arms it. Idempotent via the
    // same _refd flag listen()/close() manage.
    ref() { if (!this._refd) { this._refd = true; loop()?.ref(); } return this; }
    unref() { if (this._refd) { this._refd = false; loop()?.unref(); } return this; }

    close(cb) {
      this.listening = false;
      if (this._refd) { this._refd = false; loop()?.unref(); }
      if (cb) this.once("close", cb);
      queueMicrotask(() => this.emit("close"));
      return this;
    }
  }

  // net.connect(...) / net.createConnection(...) — construct a Socket and drive
  // its connect(); all the arg-shape handling lives on Socket.connect().
  const connect = (...args) => new Socket(null).connect(...args);

  const createServer = (opts, connectionListener) => new Server(opts, connectionListener);

  // net.SocketAddress — a value object describing an address/port/family, used by
  // BlockList and returned by newer socket APIs.
  class SocketAddress {
    constructor(options = {}) {
      const family = (options.family || "ipv4").toLowerCase();
      if (family !== "ipv4" && family !== "ipv6") {
        throw new TypeError('The "family" argument must be one of: "ipv4", "ipv6"');
      }
      this.address = options.address || (family === "ipv4" ? "127.0.0.1" : "::");
      this.port = options.port | 0;
      this.family = family;
      this.flowlabel = options.flowlabel | 0;
    }
  }

  // net.BlockList — an allow/deny set of addresses, ranges, and subnets. WorkerOS
  // is loopback-only, but packages and Node's tests construct and query these, so
  // the rule engine is implemented for IPv4 (IPv6 is compared literally).
  const ipv4ToInt = (s) => {
    const parts = String(s).split(".");
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      const b = Number(p);
      if (!Number.isInteger(b) || b < 0 || b > 255) return null;
      n = n * 256 + b;
    }
    return n >>> 0;
  };
  const addrOf = (value, family) =>
    value instanceof SocketAddress ? value.address : String(value);
  const familyOf = (value, family) =>
    (value instanceof SocketAddress ? value.family : family || "ipv4").toLowerCase();

  class BlockList {
    constructor() { this.rules = []; }
    get [Symbol.toStringTag]() { return "BlockList"; }

    addAddress(address, family = "ipv4") {
      const fam = familyOf(address, family);
      this.rules.push({ kind: "address", address: addrOf(address, fam), family: fam });
    }
    addRange(start, end, family = "ipv4") {
      const fam = familyOf(start, family);
      this.rules.push({ kind: "range", start: addrOf(start, fam), end: addrOf(end, fam), family: fam });
    }
    addSubnet(net, prefix, family = "ipv4") {
      const fam = familyOf(net, family);
      this.rules.push({ kind: "subnet", net: addrOf(net, fam), prefix: prefix | 0, family: fam });
    }
    check(address, family = "ipv4") {
      const fam = familyOf(address, family);
      const addr = addrOf(address, fam);
      for (const rule of this.rules) {
        if (rule.family !== fam) continue;
        if (fam === "ipv4") {
          const a = ipv4ToInt(addr);
          if (a == null) continue;
          if (rule.kind === "address" && a === ipv4ToInt(rule.address)) return true;
          if (rule.kind === "range" && a >= ipv4ToInt(rule.start) && a <= ipv4ToInt(rule.end)) return true;
          if (rule.kind === "subnet") {
            const base = ipv4ToInt(rule.net);
            const mask = rule.prefix === 0 ? 0 : (0xffffffff << (32 - rule.prefix)) >>> 0;
            if ((a & mask) === (base & mask)) return true;
          }
        } else if (rule.kind === "address" && rule.address === addr) {
          return true;
        }
      }
      return false;
    }
  }

  // net.Server()/net.Socket() must work with or without `new` (Node calls them
  // both ways); a Proxy adds the missing call behavior while leaving `new`,
  // `instanceof`, and subclassing (`class X extends net.Socket`) intact.
  const callable = (Cls) =>
    new Proxy(Cls, { apply: (Target, _thisArg, args) => Reflect.construct(Target, args) });

  // Loose IP helpers Node exposes; good enough for feature-detection.
  const isIPv4 = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(s));
  const isIPv6 = (s) => String(s).includes(":");
  const isIP = (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0);

  // Node's Happy Eyeballs tuning state. WorkerOS loopback has no address-family
  // race, but packages and Node's test harness use these accessors for setup.
  let autoSelectFamilyAttemptTimeout = 250;
  const getDefaultAutoSelectFamilyAttemptTimeout = () => autoSelectFamilyAttemptTimeout;
  const setDefaultAutoSelectFamilyAttemptTimeout = (value) => {
    const timeout = Number(value);
    if (!Number.isInteger(timeout) || timeout < 1) {
      throw new RangeError("attempt timeout must be a positive integer");
    }
    autoSelectFamilyAttemptTimeout = timeout;
  };

  const net = {
    Server: callable(Server),
    Socket: callable(Socket),
    Stream: callable(Socket), // legacy alias Node still exposes
    BlockList,
    SocketAddress,
    createServer,
    connect,
    createConnection: connect,
    isIP,
    isIPv4,
    isIPv6,
    getDefaultAutoSelectFamilyAttemptTimeout,
    setDefaultAutoSelectFamilyAttemptTimeout,
    // Windows-only internal Node exposes; a no-op everywhere else.
    _setSimultaneousAccepts() {},
  };
  net.default = net;
  return net;
}
