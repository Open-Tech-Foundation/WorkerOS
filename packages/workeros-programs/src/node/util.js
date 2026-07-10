// `node:util` — a Node-compatible util module for the WorkerOS Node runtime.
//
// GUEST code (INV-1): the widely-used surface — `promisify`/`callbackify`,
// `inspect` (+ its `custom` symbol) and `format`/`formatWithOptions`, `deprecate`,
// `inherits`, `isDeepStrictEqual`, `types.*`, `debuglog`, the legacy `is*`
// predicates, and the `TextEncoder`/`TextDecoder` re-exports. `inspect` is a real
// recursive formatter (depth limit, circular detection, custom-symbol hook,
// Map/Set/Date/RegExp/Error/typed-array handling), not a `JSON.stringify` stand-in.
// Pure JS — no kernel involvement.

const customInspect = Symbol.for("nodejs.util.inspect.custom");
const kPromisifyCustom = Symbol.for("nodejs.util.promisify.custom");

// ---- inspect --------------------------------------------------------------

const quoteString = (s) =>
  `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

const fnName = (f) => {
  const name = f.name;
  const tag = /^class[\s{]/.test(Function.prototype.toString.call(f)) ? "class" : "Function";
  return name ? `[${tag}: ${name}]` : `[${tag} (anonymous)]`;
};

const keyText = (k) =>
  typeof k === "symbol" ? `[${k.toString()}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? k : quoteString(k);

function inspect(value, opts = {}) {
  const ctx = {
    depth: opts.depth === undefined ? 2 : opts.depth,
    seen: new Set(),
    showHidden: !!opts.showHidden,
  };
  return format(value, ctx, 0);
}
inspect.custom = customInspect;
inspect.defaultOptions = { depth: 2 };

function format(value, ctx, level) {
  switch (typeof value) {
    case "undefined": return "undefined";
    case "boolean": return String(value);
    case "number": return Object.is(value, -0) ? "-0" : String(value);
    case "bigint": return `${value}n`;
    case "symbol": return value.toString();
    case "string": return quoteString(value);
    case "function": return fnName(value);
  }
  if (value === null) return "null";

  // Custom inspection (our Buffer, and any object opting in).
  const custom = value[customInspect];
  if (typeof custom === "function") {
    const r = custom.call(value, ctx.depth, ctx);
    return typeof r === "string" ? r : format(r, ctx, level);
  }

  if (ctx.seen.has(value)) return "[Circular *1]";

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;

  const overDepth = ctx.depth !== null && level > ctx.depth;

  if (Array.isArray(value)) {
    if (overDepth) return "[Array]";
    ctx.seen.add(value);
    const items = value.map((v) => format(v, ctx, level + 1));
    ctx.seen.delete(value);
    return items.length ? `[ ${items.join(", ")} ]` : "[]";
  }
  if (value instanceof Map) {
    if (overDepth) return "[Map]";
    ctx.seen.add(value);
    const items = [...value].map(([k, v]) => `${format(k, ctx, level + 1)} => ${format(v, ctx, level + 1)}`);
    ctx.seen.delete(value);
    return `Map(${value.size}) ${items.length ? `{ ${items.join(", ")} }` : "{}"}`;
  }
  if (value instanceof Set) {
    if (overDepth) return "[Set]";
    ctx.seen.add(value);
    const items = [...value].map((v) => format(v, ctx, level + 1));
    ctx.seen.delete(value);
    return `Set(${value.size}) ${items.length ? `{ ${items.join(", ")} }` : "{}"}`;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const name = value[Symbol.toStringTag] || value.constructor?.name || "TypedArray";
    return `${name}(${value.length}) [ ${Array.from(value).join(", ")} ]`;
  }

  // Plain / class object.
  if (overDepth) return "[Object]";
  const ctorName = value.constructor && value.constructor !== Object ? value.constructor.name : "";
  const prefix = ctorName && ctorName !== "Object" ? `${ctorName} ` : "";
  ctx.seen.add(value);
  const keys = ctx.showHidden ? Reflect.ownKeys(value) : Object.keys(value);
  const parts = keys.map((k) => `${keyText(k)}: ${format(value[k], ctx, level + 1)}`);
  ctx.seen.delete(value);
  return parts.length ? `${prefix}{ ${parts.join(", ")} }` : `${prefix}{}`;
}

// ---- format / formatWithOptions ------------------------------------------

const SPEC = /%[sdifjoOc%]/g;

function formatWithOptions(opts, ...args) {
  if (typeof args[0] !== "string") {
    return args.map((a) => (typeof a === "string" ? a : inspect(a, opts))).join(" ");
  }
  // Just the format string, no substitution args: Node returns it verbatim
  // (specifiers, including %%, are left untouched).
  if (args.length === 1) return args[0];
  let i = 1;
  let out = args[0].replace(SPEC, (m) => {
    if (m === "%%") return "%";
    if (i >= args.length) return m;
    const a = args[i];
    switch (m) {
      case "%s":
        i++;
        return typeof a === "bigint" ? `${a}n`
          : typeof a === "object" && a !== null ? inspect(a, { ...opts, depth: 0 })
          : String(a);
      case "%d": i++; return typeof a === "bigint" ? `${a}n` : String(Number(a));
      case "%i": i++; return typeof a === "bigint" ? `${a}n` : String(parseInt(a, 10));
      case "%f": i++; return String(parseFloat(a));
      case "%j": i++; try { return JSON.stringify(a); } catch { return "[Circular]"; }
      case "%o": i++; return inspect(a, { ...opts, showHidden: true, depth: 4 });
      case "%O": i++; return inspect(a, opts);
      case "%c": i++; return ""; // CSS directive — consumed, produces no output
      default: return m;
    }
  });
  for (; i < args.length; i++) out += " " + (typeof args[i] === "string" ? args[i] : inspect(args[i], opts));
  return out;
}
const nodeFormat = (...args) => formatWithOptions({}, ...args);

// ---- promisify / callbackify ---------------------------------------------

function promisify(original) {
  if (typeof original !== "function") throw new TypeError('The "original" argument must be a function');
  if (original[kPromisifyCustom]) return original[kPromisifyCustom];
  function promisified(...args) {
    return new Promise((resolve, reject) => {
      original.call(this, ...args, (err, ...values) => {
        if (err) reject(err);
        else resolve(values.length > 1 ? values : values[0]);
      });
    });
  }
  Object.setPrototypeOf(promisified, Object.getPrototypeOf(original));
  try {
    Object.defineProperties(promisified, Object.getOwnPropertyDescriptors(original));
  } catch { /* non-configurable own props (length/name) — best effort */ }
  return promisified;
}
promisify.custom = kPromisifyCustom;

function callbackify(original) {
  if (typeof original !== "function") throw new TypeError('The "original" argument must be a function');
  return function callbackified(...args) {
    const cb = args.pop();
    original.apply(this, args).then(
      (value) => queueMicrotask(() => cb(null, value)),
      (reason) => queueMicrotask(() =>
        cb(reason || Object.assign(new Error("Promise was rejected with a falsy value"), { reason })),
      ),
    );
  };
}

// ---- misc helpers ---------------------------------------------------------

function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

const emitWarning = (msg, type, code) =>
  globalThis.process?.emitWarning
    ? globalThis.process.emitWarning(msg, type, code)
    : console.warn(`${type || "Warning"}: ${msg}`);

function deprecate(fn, msg, code) {
  let warned = false;
  function deprecated(...args) {
    if (!warned) { warned = true; emitWarning(msg, "DeprecationWarning", code); }
    return fn.apply(this, args);
  }
  return deprecated;
}

function debuglog(section) {
  const env = globalThis.process?.env?.NODE_DEBUG || "";
  const enabled = env
    .split(/[\s,]+/)
    .some((s) => s && (s === "*" || s.toLowerCase() === section.toLowerCase() ||
      (s.endsWith("*") && section.toLowerCase().startsWith(s.slice(0, -1).toLowerCase()))));
  const logger = enabled
    ? (...a) => console.error(`${section.toUpperCase()} ${globalThis.process?.pid ?? 0}: ${nodeFormat(...a)}`)
    : () => {};
  logger.enabled = enabled;
  return logger;
}

function isDeepStrictEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) { if (!b.has(k) || !isDeepStrictEqual(v, b.get(k))) return false; }
    return true;
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  const ak = Reflect.ownKeys(a);
  const bk = Reflect.ownKeys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) { if (!Object.prototype.hasOwnProperty.call(b, k) || !isDeepStrictEqual(a[k], b[k])) return false; }
  return true;
}

const stripVTControlCharacters = (str) =>
  // eslint-disable-next-line no-control-regex
  String(str).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");

const types = {
  isDate: (v) => v instanceof Date,
  isRegExp: (v) => v instanceof RegExp,
  isNativeError: (v) => v instanceof Error,
  isPromise: (v) => v instanceof Promise,
  isMap: (v) => v instanceof Map,
  isSet: (v) => v instanceof Set,
  isWeakMap: (v) => v instanceof WeakMap,
  isWeakSet: (v) => v instanceof WeakSet,
  isArrayBuffer: (v) => v instanceof ArrayBuffer,
  isSharedArrayBuffer: (v) => typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer,
  isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer),
  isDataView: (v) => v instanceof DataView,
  isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v) => v instanceof Uint8Array,
  isBoxedPrimitive: (v) => v instanceof Number || v instanceof String || v instanceof Boolean,
  isAsyncFunction: (v) => typeof v === "function" && v.constructor && v.constructor.name === "AsyncFunction",
  isGeneratorFunction: (v) => typeof v === "function" && v.constructor && v.constructor.name === "GeneratorFunction",
};

// Legacy `util.is*` predicates (deprecated in Node but still used).
const legacy = {
  isArray: Array.isArray,
  isBoolean: (v) => typeof v === "boolean",
  isNull: (v) => v === null,
  isNullOrUndefined: (v) => v == null,
  isNumber: (v) => typeof v === "number",
  isString: (v) => typeof v === "string",
  isSymbol: (v) => typeof v === "symbol",
  isUndefined: (v) => v === undefined,
  isRegExp: (v) => v instanceof RegExp,
  isObject: (v) => v !== null && typeof v === "object",
  isDate: (v) => v instanceof Date,
  isError: (v) => v instanceof Error,
  isFunction: (v) => typeof v === "function",
  isPrimitive: (v) => v === null || (typeof v !== "object" && typeof v !== "function"),
  isBuffer: (v) => (globalThis.Buffer ? globalThis.Buffer.isBuffer(v) : false),
  _extend: (target, source) => Object.assign(target, source),
};

export {
  inspect, nodeFormat as format, formatWithOptions,
  promisify, callbackify, inherits, deprecate, debuglog,
  isDeepStrictEqual, types, stripVTControlCharacters,
};
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;

// The `node:util` module object (import + require share one surface).
export const util = {
  inspect,
  format: nodeFormat,
  formatWithOptions,
  promisify,
  callbackify,
  inherits,
  deprecate,
  debuglog,
  isDeepStrictEqual,
  types,
  stripVTControlCharacters,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  ...legacy,
};
export default util;
