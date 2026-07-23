// `node:console` — the Console class and the module returned by
// `require('console')`, for the WorkerOS Node runtime.
//
// GUEST code (INV-1). The process already has a routing `globalThis.console`
// (installed by the program worker); this module exposes it as a requireable
// builtin AND provides the `Console` constructor, which real code uses to build
// a console bound to arbitrary streams — undici (bundled into Next.js's
// @edge-runtime/primitives) does `new Console({ stdout }).table(rows)` to render
// a table into a capture stream. Formatting goes through node:util so it matches
// the rest of the runtime.

import utilModule from "./util.js";

const format = utilModule.format || ((...a) => a.map(String).join(" "));
const inspect = utilModule.inspect || ((v) => String(v));

const writeTo = (stream, s) => {
  if (stream && typeof stream.write === "function") stream.write(s);
};

// Minimal, non-throwing console.table: an array (or object) of row objects →
// an aligned ASCII grid with an "(index)" column, close enough to Node's output
// for the rare formatter that reads it back. Falls back to inspect() for shapes
// that aren't tabular.
function renderTable(data) {
  if (data == null || typeof data !== "object") return inspect(data);
  const rows = Array.isArray(data) ? data.map((v, i) => [String(i), v]) : Object.entries(data);
  const columns = [];
  const hasValuesColumn = rows.some(([, v]) => v == null || typeof v !== "object");
  for (const [, v] of rows) {
    if (v && typeof v === "object") for (const k of Object.keys(v)) if (!columns.includes(k)) columns.push(k);
  }
  const header = ["(index)", ...columns, ...(hasValuesColumn ? ["Values"] : [])];
  const cell = (v) => (typeof v === "string" ? v : inspect(v));
  const body = rows.map(([idx, v]) => {
    const line = [idx];
    for (const c of columns) line.push(v && typeof v === "object" && c in v ? cell(v[c]) : "");
    if (hasValuesColumn) line.push(v == null || typeof v !== "object" ? cell(v) : "");
    return line;
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] || "").length)));
  const fmtRow = (r) => "│ " + r.map((c, i) => (c || "").padEnd(widths[i])).join(" │ ") + " │";
  const sep = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  return [sep("┌", "┬", "┐"), fmtRow(header), sep("├", "┼", "┤"), ...body.map(fmtRow), sep("└", "┴", "┘")].join("\n");
}

export class Console {
  constructor(optionsOrStdout, maybeStderr) {
    let stdout, stderr, options;
    if (optionsOrStdout && typeof optionsOrStdout === "object" && !optionsOrStdout.write) {
      // { stdout, stderr, inspectOptions, ... } form
      stdout = optionsOrStdout.stdout;
      stderr = optionsOrStdout.stderr || optionsOrStdout.stdout;
      options = optionsOrStdout;
    } else {
      stdout = optionsOrStdout;
      stderr = maybeStderr || optionsOrStdout;
      options = {};
    }
    this._stdout = stdout;
    this._stderr = stderr;
    this._inspectOptions = options.inspectOptions || {};
    this._indent = "";
    this._counts = new Map();
    this._times = new Map();
    // Node exposes console methods as own, bound properties (so they can be
    // destructured / passed around), plus a `Console` back-reference.
    const bind = (name) => { this[name] = this[name].bind(this); };
    for (const m of [
      "log", "info", "debug", "dir", "dirxml", "table", "warn", "error", "trace",
      "assert", "count", "countReset", "time", "timeEnd", "timeLog", "group",
      "groupCollapsed", "groupEnd", "clear",
    ]) bind(m);
    this.Console = Console;
  }

  _out(args) { writeTo(this._stdout, this._indent + format(...args) + "\n"); }
  _err(args) { writeTo(this._stderr, this._indent + format(...args) + "\n"); }

  log(...a) { this._out(a); }
  info(...a) { this._out(a); }
  debug(...a) { this._out(a); }
  dir(obj, opts) { writeTo(this._stdout, this._indent + inspect(obj, { ...this._inspectOptions, ...opts }) + "\n"); }
  dirxml(...a) { this._out(a); }
  table(data) { writeTo(this._stdout, this._indent + renderTable(data) + "\n"); }
  warn(...a) { this._err(a); }
  error(...a) { this._err(a); }
  trace(...a) { this._err(["Trace:", ...a]); }
  assert(cond, ...a) { if (!cond) this._err(["Assertion failed:", ...a]); }
  count(label = "default") { const n = (this._counts.get(label) || 0) + 1; this._counts.set(label, n); this._out([`${label}: ${n}`]); }
  countReset(label = "default") { this._counts.delete(label); }
  time(label = "default") { this._times.set(label, Date.now()); }
  timeEnd(label = "default") { const t = this._times.get(label); if (t != null) { this._out([`${label}: ${Date.now() - t}ms`]); this._times.delete(label); } }
  timeLog(label = "default", ...a) { const t = this._times.get(label); if (t != null) this._out([`${label}: ${Date.now() - t}ms`, ...a]); }
  group(...a) { if (a.length) this._out(a); this._indent += "  "; }
  groupCollapsed(...a) { if (a.length) this._out(a); this._indent += "  "; }
  groupEnd() { this._indent = this._indent.slice(0, -2); }
  clear() {}
}

// The module returned by `require('console')`: the live global console methods
// (routing to the process's stdout/stderr) plus the `Console` constructor —
// Node's shape, where `require('console')` is a Console-like bound to the
// process streams and also carries `.Console`.
const consoleModule = Object.create(null);
for (const name of [
  "log", "info", "debug", "dir", "dirxml", "table", "warn", "error", "trace",
  "assert", "count", "countReset", "time", "timeEnd", "timeLog", "group",
  "groupCollapsed", "groupEnd", "clear", "timeStamp", "profile", "profileEnd",
]) {
  consoleModule[name] = (...args) => {
    const c = globalThis.console;
    if (c && typeof c[name] === "function") return c[name](...args);
  };
}
consoleModule.Console = Console;
consoleModule.default = consoleModule;

export default consoleModule;
