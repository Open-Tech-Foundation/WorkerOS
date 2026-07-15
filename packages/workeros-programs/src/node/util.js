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

// `util.styleText(format, text)` — wrap `text` in the ANSI SGR codes named by
// `format` (a style name or an array of them), as Node ≥20.12 / 22. The code
// table mirrors Node's `util.inspect.colors`. `'none'` is the documented no-op.
// Colors are always applied here (equivalent to Node's `validateStream:false`);
// the OS terminal is a real ANSI TTY, so a scaffolder's colored prompts render.
const STYLE_CODES = {
  reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24],
  blink: [5, 25], inverse: [7, 27], hidden: [8, 28], strikethrough: [9, 29],
  doubleunderline: [21, 24], framed: [51, 54], overlined: [53, 55],
  black: [30, 39], red: [31, 39], green: [32, 39], yellow: [33, 39],
  blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39],
  gray: [90, 39], grey: [90, 39],
  blackBright: [90, 39], redBright: [91, 39], greenBright: [92, 39], yellowBright: [93, 39],
  blueBright: [94, 39], magentaBright: [95, 39], cyanBright: [96, 39], whiteBright: [97, 39],
  bgBlack: [40, 49], bgRed: [41, 49], bgGreen: [42, 49], bgYellow: [43, 49],
  bgBlue: [44, 49], bgMagenta: [45, 49], bgCyan: [46, 49], bgWhite: [47, 49],
  bgGray: [100, 49], bgGrey: [100, 49],
  bgBlackBright: [100, 49], bgRedBright: [101, 49], bgGreenBright: [102, 49], bgYellowBright: [103, 49],
  bgBlueBright: [104, 49], bgMagentaBright: [105, 49], bgCyanBright: [106, 49], bgWhiteBright: [107, 49],
};

function styleText(format, text) {
  if (typeof text !== "string") {
    const e = new TypeError(`The "text" argument must be of type string. Received type ${typeof text}`);
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  const formats = Array.isArray(format) ? format : [format];
  let open = "";
  let close = "";
  for (const f of formats) {
    if (f === "none") continue;
    const code = STYLE_CODES[f];
    if (code === undefined) {
      const e = new TypeError(`The value "${String(f)}" is invalid for argument 'format'`);
      e.code = "ERR_INVALID_ARG_VALUE";
      throw e;
    }
    open += `\x1b[${code[0]}m`;
    close = `\x1b[${code[1]}m` + close;
  }
  return open + text + close;
}

const types = {
  isArgumentsObject: (v) => Object.prototype.toString.call(v) === "[object Arguments]",
  isDate: (v) => v instanceof Date,
  isRegExp: (v) => v instanceof RegExp,
  isNativeError: (v) => v instanceof Error,
  isPromise: (v) => v instanceof Promise || Object.prototype.toString.call(v) === "[object Promise]",
  isMap: (v) => v instanceof Map,
  isSet: (v) => v instanceof Set,
  isWeakMap: (v) => v instanceof WeakMap,
  isWeakSet: (v) => v instanceof WeakSet,
  isMapIterator: (v) => Object.prototype.toString.call(v) === "[object Map Iterator]",
  isSetIterator: (v) => Object.prototype.toString.call(v) === "[object Set Iterator]",
  isArrayBuffer: (v) => v instanceof ArrayBuffer,
  isSharedArrayBuffer: (v) => typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer,
  isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer),
  isArrayBufferView: (v) => ArrayBuffer.isView(v),
  isDataView: (v) => v instanceof DataView,
  isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8ClampedArray: (v) => v instanceof Uint8ClampedArray,
  isUint8Array: (v) => v instanceof Uint8Array,
  isUint16Array: (v) => v instanceof Uint16Array,
  isUint32Array: (v) => v instanceof Uint32Array,
  isInt8Array: (v) => v instanceof Int8Array,
  isInt16Array: (v) => v instanceof Int16Array,
  isInt32Array: (v) => v instanceof Int32Array,
  isFloat16Array: (v) => typeof Float16Array !== "undefined" && v instanceof Float16Array,
  isFloat32Array: (v) => v instanceof Float32Array,
  isFloat64Array: (v) => v instanceof Float64Array,
  isBigInt64Array: (v) => typeof BigInt64Array !== "undefined" && v instanceof BigInt64Array,
  isBigUint64Array: (v) => typeof BigUint64Array !== "undefined" && v instanceof BigUint64Array,
  isNumberObject: (v) => v instanceof Number,
  isStringObject: (v) => v instanceof String,
  isBooleanObject: (v) => v instanceof Boolean,
  isBigIntObject: (v) => Object.prototype.toString.call(v) === "[object BigInt]",
  isSymbolObject: (v) => Object.prototype.toString.call(v) === "[object Symbol]",
  isBoxedPrimitive: (v) =>
    v instanceof Number || v instanceof String || v instanceof Boolean ||
    Object.prototype.toString.call(v) === "[object BigInt]" ||
    Object.prototype.toString.call(v) === "[object Symbol]",
  isAsyncFunction: (v) => typeof v === "function" && v.constructor && v.constructor.name === "AsyncFunction",
  isGeneratorFunction: (v) => typeof v === "function" && v.constructor && v.constructor.name === "GeneratorFunction",
  isGeneratorObject: (v) => Object.prototype.toString.call(v) === "[object Generator]",
  isModuleNamespaceObject: (v) => Object.prototype.toString.call(v) === "[object Module]",
  isCryptoKey: (v) => typeof CryptoKey !== "undefined" && v instanceof CryptoKey,
  // V8 embedder concepts have no observable equivalent in a browser worker.
  isExternal: () => false,
  isKeyObject: () => false,
  isProxy: () => false,
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

// `util.getCallSites([frameCount][, options])` (Node ≥22.9) — an array of the
// current call stack's frames as plain objects. The Node test harness leans on it
// (`common.mustNotCall` captures the caller here), so a huge slice of the suite
// requires it. Built on V8's structured stack trace (`Error.prepareStackTrace`
// handed the raw CallSite[]), which Chromium provides; we only reshape it into
// Node's `{ functionName, scriptName, lineNumber, columnNumber }` records.
const getCallSites = (frameCount = 10, options) => {
  if (typeof frameCount === "object" && frameCount !== null) { options = frameCount; frameCount = 10; }
  const limit = Math.max(0, frameCount | 0);
  const holder = {};
  const prev = Error.prepareStackTrace;
  const prevLimit = Error.stackTraceLimit;
  // +1: frame 0 is this getCallSites call itself, which Node omits from the result.
  Error.stackTraceLimit = limit + 1;
  Error.prepareStackTrace = (_e, sites) => sites;
  Error.captureStackTrace(holder, getCallSites);
  const sites = holder.stack || [];
  Error.prepareStackTrace = prev;
  Error.stackTraceLimit = prevLimit;
  return sites.slice(0, limit).map((s) => {
    const column = s.getColumnNumber() ?? 0;
    return {
      functionName: s.getFunctionName() || "",
      scriptName: s.getFileName() || "",
      lineNumber: s.getLineNumber() ?? 0,
      column, // Node 22.9 name
      columnNumber: column, // Node ≥23 name; expose both so either test passes
    };
  });
};

// `util.parseEnv(content)` — parse a `.env`-format string into an object, matching
// Node's built-in dotenv parser (added in Node 20.12). Vite imports it
// (`import { parseEnv } from "node:util"`), so the export must exist or Vite's
// bundle fails to link. Char-scanned (not line-split) because a double/single/
// backtick-quoted value may span newlines. Rules mirrored from Node: skip blank
// and `#` lines; strip a leading `export ` on the key; quoted values drop their
// quotes (double quotes process `\n`/`\r`/`\t` escapes, single/backtick are
// literal); an unquoted value ends at `#` (inline comment) and is trimmed.
function parseEnv(content) {
  const s = String(content);
  const n = s.length;
  const out = {};
  const isSpace = (c) => c === " " || c === "\t" || c === "\r" || c === "\n";
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(s[i])) i++;
    if (i >= n) break;
    if (s[i] === "#") { while (i < n && s[i] !== "\n") i++; continue; }
    const keyStart = i;
    while (i < n && s[i] !== "=" && s[i] !== "\n") i++;
    if (i >= n || s[i] === "\n") continue; // no '=' on this line — skip it
    let key = s.slice(keyStart, i).trim().replace(/^export\s+/, "");
    i++; // consume '='
    while (i < n && (s[i] === " " || s[i] === "\t")) i++;
    let value = "";
    const q = s[i];
    if (q === '"' || q === "'" || q === "`") {
      i++;
      let v = "";
      while (i < n && s[i] !== q) {
        if (q === '"' && s[i] === "\\" && i + 1 < n) {
          const nx = s[i + 1];
          if (nx === "n") { v += "\n"; i += 2; continue; }
          if (nx === "r") { v += "\r"; i += 2; continue; }
          if (nx === "t") { v += "\t"; i += 2; continue; }
        }
        v += s[i++];
      }
      i++; // consume closing quote
      value = v;
      while (i < n && s[i] !== "\n") i++; // ignore the rest of the line
    } else {
      const vStart = i;
      while (i < n && s[i] !== "\n" && s[i] !== "#") i++;
      value = s.slice(vStart, i).trim();
      while (i < n && s[i] !== "\n") i++;
    }
    if (key) out[key] = value;
  }
  return out;
}

export {
  inspect, nodeFormat as format, formatWithOptions,
  promisify, callbackify, inherits, deprecate, debuglog,
  isDeepStrictEqual, types, stripVTControlCharacters, styleText, getCallSites, parseEnv,
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
  styleText,
  getCallSites,
  parseEnv,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  ...legacy,
};
export default util;
