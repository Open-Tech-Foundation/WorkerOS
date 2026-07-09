// workeros-node — the Node.js compatibility tenant layer.
//
// This is a GUEST-side program. It runs on top of the Node-agnostic kernel and
// maps Node semantics (`process`, `fs`, `path`, eventually `require`) onto the
// kernel's WASI-shaped primitives (INV-1 / ADR-007). Nothing here belongs in the
// kernel — on real Linux, Node is just a program, and the same is true here.
//
// Phase 0: an empty stub. Phase 2 grows it a minimal `process` shim
// (argv/env/stdout.write/exit); Phase 5 grows the `require`/`node_modules` graph.

export const version = "0.0.0";
