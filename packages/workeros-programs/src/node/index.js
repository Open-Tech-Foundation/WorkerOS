// The Node-compatible guest runtime for WorkerOS.
//
// This is GUEST code (INV-1): the kernel knows nothing about `require`, package
// folders, or `node_modules`. On real Linux, Node is just a program; the same is
// true here. Node compatibility is an ongoing, incremental effort — grow it here.

export { createProcess, ProcessExit } from "./process-shim.js";
export { createNodeRuntime, usesCommonjs } from "./require-runtime.js";
