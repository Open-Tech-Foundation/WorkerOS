// `node:v8` — a minimal surface. npm's arborist reads
// `getHeapStatistics().heap_size_limit` to size its packument LRU cache; other
// entry points are approximations so tooling that pokes at them doesn't crash.
// There is no V8 introspection in the browser, so we report a plausible heap.

export function createV8() {
  // Chrome exposes a non-standard `performance.memory.jsHeapSizeLimit`; use it when
  // present, else assume a 2 GiB heap so cache sizing stays sane.
  const heapLimit = globalThis.performance?.memory?.jsHeapSizeLimit || 2 * 1024 * 1024 * 1024;
  const used = globalThis.performance?.memory?.usedJSHeapSize || 16 * 1024 * 1024;
  const total = globalThis.performance?.memory?.totalJSHeapSize || 32 * 1024 * 1024;
  const v8 = {
    getHeapStatistics: () => ({
      total_heap_size: total,
      total_heap_size_executable: 0,
      total_physical_size: total,
      total_available_size: heapLimit - used,
      used_heap_size: used,
      heap_size_limit: heapLimit,
      malloced_memory: 0,
      peak_malloced_memory: 0,
      does_zap_garbage: 0,
      number_of_native_contexts: 1,
      number_of_detached_contexts: 0,
      total_global_handles_size: 0,
      used_global_handles_size: 0,
      external_memory: 0,
    }),
    getHeapSpaceStatistics: () => [],
    getHeapCodeStatistics: () => ({ code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0 }),
    setFlagsFromString: () => {},
    getHeapSnapshot: () => { throw new Error("node:v8 getHeapSnapshot is not supported in WorkerOS"); },
    // A JSON-based stand-in for the structured serializer — npm only round-trips
    // JSON-shaped packument data through it, so this preserves that faithfully.
    serialize: (value) => Buffer.from(JSON.stringify(value ?? null), "utf8"),
    deserialize: (buf) => JSON.parse(Buffer.from(buf).toString("utf8") || "null"),
    Serializer: class Serializer {},
    Deserializer: class Deserializer {},
    DefaultSerializer: class DefaultSerializer {},
    DefaultDeserializer: class DefaultDeserializer {},
  };
  v8.default = v8;
  return v8;
}
