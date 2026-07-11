// `node:perf_hooks` - performance measurement for the WorkerOS Node runtime.
//
// GUEST code (INV-1). Web Workers already expose the Web Performance API, so
// marks, measures, entries, and observers are the host-native implementations.
// Node's libuv-specific event-loop metrics are approximated explicitly: delay is
// sampled with a timer and utilization reports elapsed active worker time.

const hostPerformance = globalThis.performance || {
  timeOrigin: Date.now(),
  now: () => Date.now(),
};

const toNs = (ms) => Math.max(1, Math.round(ms * 1e6));

class Histogram {
  constructor() {
    this.reset();
    this._deltaMark = hostPerformance.now();
  }

  get count() { return this._values.length; }
  get countBigInt() { return BigInt(this.count); }
  get min() { return this.count ? Math.min(...this._values) : Number.MAX_SAFE_INTEGER; }
  get minBigInt() { return BigInt(this.min); }
  get max() { return this.count ? Math.max(...this._values) : 0; }
  get maxBigInt() { return BigInt(this.max); }
  get mean() {
    return this.count ? this._values.reduce((sum, n) => sum + n, 0) / this.count : NaN;
  }
  get stddev() {
    if (!this.count) return NaN;
    const mean = this.mean;
    return Math.sqrt(this._values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / this.count);
  }
  get exceeds() { return 0; }
  get exceedsBigInt() { return 0n; }
  get percentiles() {
    return new Map([0, 25, 50, 75, 90, 99, 100].map((p) => [p, this.percentile(p)]));
  }

  percentile(percentile) {
    if (!this.count) return 0;
    const p = Number(percentile);
    if (!(p > 0 && p <= 100)) throw new RangeError("percentile must be > 0 and <= 100");
    const sorted = [...this._values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  }

  percentileBigInt(percentile) { return BigInt(this.percentile(percentile)); }

  record(value) {
    const n = typeof value === "bigint" ? Number(value) : value;
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("value must be a positive integer");
    this._values.push(n);
  }

  recordDelta() {
    const now = hostPerformance.now();
    this.record(toNs(now - this._deltaMark));
    this._deltaMark = now;
  }

  add(other) {
    if (!other || !Array.isArray(other._values)) throw new TypeError("other must be a histogram");
    this._values.push(...other._values);
  }

  reset() {
    this._values = [];
    this._deltaMark = hostPerformance.now();
  }
}

class IntervalHistogram extends Histogram {
  constructor(resolution) {
    super();
    this.resolution = resolution;
    this._timer = null;
  }

  enable() {
    if (this._timer !== null) return false;
    let expected = hostPerformance.now() + this.resolution;
    this._timer = setInterval(() => {
      const now = hostPerformance.now();
      this._values.push(toNs(Math.max(0, now - expected)));
      expected = now + this.resolution;
    }, this.resolution);
    this._timer.unref?.();
    return true;
  }

  disable() {
    if (this._timer === null) return false;
    clearInterval(this._timer);
    this._timer = null;
    return true;
  }
}

export function createHistogram() {
  return new Histogram();
}

export function monitorEventLoopDelay(options = {}) {
  const resolution = options.resolution === undefined ? 10 : Number(options.resolution);
  if (!Number.isInteger(resolution) || resolution < 1) {
    throw new RangeError("resolution must be a positive integer");
  }
  return new IntervalHistogram(resolution);
}

const utilizationOrigin = hostPerformance.now();
function eventLoopUtilization(previous) {
  const current = { idle: 0, active: hostPerformance.now() - utilizationOrigin, utilization: 1 };
  if (!previous) return current;
  const active = Math.max(0, current.active - Number(previous.active || 0));
  const idle = Math.max(0, current.idle - Number(previous.idle || 0));
  return { idle, active, utilization: active + idle ? active / (active + idle) : 0 };
}

function timerify(fn, options = {}) {
  if (typeof fn !== "function") throw new TypeError("fn must be a function");
  const wrapped = function (...args) {
    const start = hostPerformance.now();
    const finish = () => options.histogram?.record(toNs(hostPerformance.now() - start));
    try {
      const result = Reflect.apply(fn, this, args);
      if (result && typeof result.then === "function") return result.finally(finish);
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  };
  Object.defineProperty(wrapped, "name", { value: `timerified ${fn.name || "anonymous"}` });
  return wrapped;
}

// Expose the browser Performance object with Node's two additional helpers. Most
// workers let us extend it; use a binding proxy only on hosts that freeze it.
//
// `timerify` is always our own: it pairs with our `createHistogram()`, so it must
// not defer to a host native `timerify` (Node's rejects any histogram that isn't
// its internal RecordableHistogram). `eventLoopUtilization` has no such coupling,
// so we keep a host-native one when present and only fill it in otherwise.
const extendPerformance = () => {
  try {
    if (!hostPerformance.eventLoopUtilization) hostPerformance.eventLoopUtilization = eventLoopUtilization;
    hostPerformance.timerify = timerify;
    return hostPerformance;
  } catch {
    return new Proxy(hostPerformance, {
      get(target, key) {
        if (key === "eventLoopUtilization") return eventLoopUtilization;
        if (key === "timerify") return timerify;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
};
export const performance = extendPerformance();

export const Performance = globalThis.Performance;
export const PerformanceObserver = globalThis.PerformanceObserver;
export const PerformanceObserverEntryList = globalThis.PerformanceObserverEntryList;
export const PerformanceEntry = globalThis.PerformanceEntry;
export const PerformanceMark = globalThis.PerformanceMark;
export const PerformanceMeasure = globalThis.PerformanceMeasure;
export const PerformanceNodeTiming = globalThis.PerformanceNodeTiming;
export const PerformanceResourceTiming = globalThis.PerformanceResourceTiming;

export const constants = Object.freeze({
  NODE_PERFORMANCE_GC_MAJOR: 4,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 8,
  NODE_PERFORMANCE_GC_WEAKCB: 2,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0,
  NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
  NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
  NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
  NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
});

const perfHooks = {
  performance,
  Performance,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceNodeTiming,
  PerformanceResourceTiming,
  monitorEventLoopDelay,
  createHistogram,
  constants,
};

export default perfHooks;
