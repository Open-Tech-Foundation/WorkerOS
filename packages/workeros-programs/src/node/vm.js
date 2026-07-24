// `node:vm` — compile and run code with an explicitly chosen global scope.
//
// GUEST code (INV-1): pure userland over the host JavaScript engine. This is the
// module Node's own test suite (and its private `test/common` harness) leans on to
// probe the runtime — most `test-*.js` that inspect globals, contextify a sandbox,
// or run source with a specific `this`-context go through `vm`. Covering it is what
// lets those upstream files execute under WorkerOS at all.
//
// Honest limits (INV-5): WorkerOS runs in a Web Worker, which has no iframe and no
// way to allocate a fresh V8 context/realm with its own intrinsics. So:
//   - `runInThisContext` is exact — it is indirect `eval`, i.e. code evaluated in
//     the current global scope with no access to the caller's locals, which is
//     precisely Node's contract for this call.
//   - A "context" (`createContext` / `runInNewContext` / `runInContext`) is NOT a
//     separate realm. It is a Proxy-scoped sandbox that shares the host's
//     intrinsics (`Object`, `Array`, `Math`, …) and, unavoidably, the host's other
//     globals. It is therefore a *scoping* tool, not a security boundary: untrusted
//     code is not isolated here. Free-variable reads resolve to the sandbox first
//     and fall through to the real global; bare assignments (`x = 1`) land on the
//     sandbox. Top-level `var`/`function` *declarations* do not attach to the
//     sandbox object (that needs a real global object); use assignment instead.
//   - `timeout` is not enforced — JavaScript cannot preempt a synchronous eval, so
//     an infinite loop in guest code hangs the worker exactly as it would anywhere.
//   - vm ES modules (`vm.SourceTextModule`, only present under Node's
//     `--experimental-vm-modules`) are omitted, matching default Node.

import { Buffer } from "./buffer.js";

// A saved, renamed binding of the global `eval`. Called as `indirectEval(src)`
// (name is not literally `eval`), it is an *indirect* eval: the source runs in the
// global scope, seeing no local variables — exactly Node's `runInThisContext`.
const indirectEval = eval;

// The set of objects that have been contextified, mapped to their scope Proxy. A
// WeakMap so a discarded sandbox is collectable and `isContext` can answer in O(1).
const contexts = new WeakMap();

function argTypeError(name, expected, actual) {
  const received =
    actual === null ? "null" : Array.isArray(actual) ? "an instance of Array" : typeof actual;
  const err = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${received}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

// Node stamps a filename onto the compiled unit so thrown errors and stacks point
// at it. A trailing `//# sourceURL=` gives the engine the same anchor; we only add
// one when a filename was supplied so anonymous code keeps the engine default.
const withSourceUrl = (code, filename) =>
  filename ? `${code}\n//# sourceURL=${filename}` : code;

const filenameOf = (options, fallback) => {
  if (typeof options === "string") return options; // Node accepts a bare filename
  const f = options && options.filename;
  return f == null ? fallback : String(f);
};

// Build the `with`-Proxy that makes a sandbox act as the global scope for code run
// inside it. `has` returns true for every name so *all* free identifiers in the
// guest resolve through this object; `get` serves the sandbox's own properties and
// falls through to the host global for shared intrinsics (Object, console, …).
// `Symbol.unscopables` must be undefined or `with` would exclude names from the
// scope; `get`/`set` reflect onto the sandbox so bare assignments are captured.
function makeScope(sandbox) {
  let proxy;
  proxy = new Proxy(sandbox, {
    has() {
      return true;
    },
    get(target, key, receiver) {
      if (key === Symbol.unscopables || key === Symbol.toStringTag) return undefined;
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      // Inside a context the global-object aliases ARE the sandbox (Node
      // semantics), not the host global. Code like Next's RSC client-reference
      // manifest does `globalThis.__RSC_MANIFEST = …` and the host then reads it
      // back off the same sandbox object — so `globalThis`/`global`/`self` must
      // reflect onto this scope, or the write leaks to the host global and is
      // invisible to the caller. Only when the sandbox doesn't define its own.
      if (key === "globalThis" || key === "global" || key === "self") return proxy;
      return globalThis[key];
    },
    set(target, key, value, receiver) {
      return Reflect.set(target, key, value, receiver);
    },
  });
  return proxy;
}

// Evaluate `code` with `sandbox` installed as the scope. The code string is
// embedded as a literal (never a free identifier), so the guest cannot see our
// wrapper machinery: inside `with (this)` the only reachable names are the
// sandbox's and the host global's. `eval` there resolves — via the Proxy — to the
// genuine %eval% intrinsic, so this is a *direct* eval and the `with` scope
// applies; `this` is a keyword, so it isn't intercepted by the Proxy's `has`.
function evalInScope(code, scope, filename) {
  const src = withSourceUrl(String(code), filename);
  const runner = new Function(`with (this) { return eval(${JSON.stringify(src)}); }`);
  return runner.call(scope);
}

export function isContext(object) {
  if (object === null || (typeof object !== "object" && typeof object !== "function")) {
    throw argTypeError("contextifiedObject", "an object", object);
  }
  return contexts.has(object);
}

export function createContext(contextObject = {}, options) {
  // Node returns the same object, now contextified in place (a fresh one when
  // called with no sandbox). Re-contextifying an already-contextified object is a
  // no-op that returns it, as in Node.
  if (contextObject === null || typeof contextObject !== "object") {
    if (typeof contextObject !== "function") {
      throw argTypeError("contextObject", "an object", contextObject);
    }
  }
  if (!contexts.has(contextObject)) contexts.set(contextObject, makeScope(contextObject));
  return contextObject;
}

export function runInContext(code, contextifiedObject, options) {
  if (!isContext(contextifiedObject)) {
    throw argTypeError("contextifiedObject", "a contextified object", contextifiedObject);
  }
  return evalInScope(code, contexts.get(contextifiedObject), filenameOf(options, undefined));
}

export function runInNewContext(code, contextObject, options) {
  const ctx = createContext(contextObject == null ? {} : contextObject);
  return runInContext(code, ctx, options);
}

export function runInThisContext(code, options) {
  if (typeof code !== "string") throw argTypeError("code", "a string", code);
  return indirectEval(withSourceUrl(code, filenameOf(options, undefined)));
}

// `vm.compileFunction(code, params, options)` — compile `code` as a function body
// with the named `params`. `parsingContext` (a contextified object) makes the
// body's free names resolve through that sandbox; `contextExtensions` layer extra
// `with` objects, matching Node's ordering (extensions outermost).
export function compileFunction(code, params = [], options = {}) {
  if (typeof code !== "string") throw argTypeError("code", "a string", code);
  const names = Array.isArray(params) ? params.map(String) : [];
  const body = withSourceUrl(code, options.filename && String(options.filename));
  const ctx = options.parsingContext;
  const extensions = Array.isArray(options.contextExtensions) ? options.contextExtensions : [];
  if ((ctx != null && contexts.has(ctx)) || extensions.length) {
    // Wrap the body so its scope chain is the parsing context plus any extensions;
    // return a function that, when called, evals the body under those `with` scopes.
    const scopes = [];
    if (ctx != null && contexts.has(ctx)) scopes.push(contexts.get(ctx));
    for (const ext of extensions) scopes.push(makeScope(ext));
    let wrapped = `return function (${names.join(", ")}) {\n${body}\n};`;
    for (let i = scopes.length - 1; i >= 0; i--) wrapped = `with (__scope${i}__) {\n${wrapped}\n}`;
    const maker = new Function(...scopes.map((_, i) => `__scope${i}__`), wrapped);
    return maker(...scopes);
  }
  return new Function(...names, body);
}

// A pre-compiled unit. In Node this caches parsed bytecode; here we hold the source
// and re-evaluate on each run (the host engine has its own parse cache keyed by the
// sourceURL). The `run*` methods mirror the free functions above.
export class Script {
  constructor(code, options = {}) {
    if (typeof code !== "string") throw argTypeError("code", "a string", code);
    this._code = code;
    this._filename = filenameOf(options, "evalmachine.<anonymous>");
    // Node exposes `cachedDataProduced`/`cachedDataRejected` when caching is used;
    // we produce no bytecode, so report that honestly rather than faking a cache.
    this.cachedDataProduced = false;
    this.cachedDataRejected = options.cachedData !== undefined ? true : undefined;
  }

  runInThisContext(options) {
    return indirectEval(withSourceUrl(this._code, this._filename));
  }

  runInContext(contextifiedObject, options) {
    if (!isContext(contextifiedObject)) {
      throw argTypeError("contextifiedObject", "a contextified object", contextifiedObject);
    }
    return evalInScope(this._code, contexts.get(contextifiedObject), this._filename);
  }

  runInNewContext(contextObject, options) {
    const ctx = createContext(contextObject == null ? {} : contextObject);
    return this.runInContext(ctx, options);
  }

  // No bytecode to serialize — return an empty buffer so callers that persist and
  // re-supply cached data don't crash; a re-supplied blob is reported as rejected.
  createCachedData() {
    return Buffer.alloc(0);
  }
}

// vm's public numeric/symbol constants. `DONT_CONTEXTIFY` is Node's marker for
// "run against the real global with no sandbox"; the memory-measurement enums are
// carried for shape so code that reads them doesn't crash (see `measureMemory`).
export const constants = Object.freeze({
  USE_MAIN_CONTEXT_DEFAULT_LOADER: 0,
  DONT_CONTEXTIFY: Symbol("vm_dont_contextify"),
  measureMemory: Object.freeze({
    mode: Object.freeze({ SUMMARY: 0, DETAILED: 1 }),
    execution: Object.freeze({ DEFAULT: 0, EAGER: 1 }),
  }),
});

// Approximated, like perf_hooks' event-loop metrics: the host engine gives no
// per-context heap breakdown from a worker, so this resolves with the documented
// shape zero-filled rather than pretending to a real measurement.
export function measureMemory(options = {}) {
  return Promise.resolve({
    total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] },
  });
}

export const vm = {
  runInThisContext,
  runInNewContext,
  runInContext,
  createContext,
  isContext,
  compileFunction,
  measureMemory,
  Script,
  constants,
};

export default vm;
