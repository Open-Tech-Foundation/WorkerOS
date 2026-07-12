//! Raw-wasm ESM→module-runner transform for the WorkerOS guest.
//!
//! `/bin/node` runs on the host JS engine (INV-1), but the browser's native ESM
//! loader can only fetch URLs and cannot link an import *cycle*. So instead of
//! handing ESM to the engine, we transform it: oxc parses the module, does scope
//! analysis, and rewrites `import`/`export`/`import.meta`/`import()` into
//! live-binding *module-runner* calls (Vite's SSR shape) — `import { b } from 'x'`
//! becomes `const _0 = await __vite_ssr_import__('x', …)` with every use of `b`
//! rewritten to `_0.b` (a live property read). The guest supplies
//! `__vite_ssr_import__` (its loader) and runs each module through the CJS runtime,
//! which already seeds `module.exports` before eval — the exact mechanism that
//! makes cycles and `require(esm)` work.
//!
//! ABI mirrors `workeros-codec`: `nb_alloc`/`nb_dealloc` + functions returning a
//! packed `(ptr<<32)|len`, so the guest instantiates this *synchronously*
//! (`new WebAssembly.Instance`) and can transform a module inside a synchronous
//! `require(esm)`.

use std::path::Path;

use oxc::allocator::Allocator;
use oxc::codegen::Codegen;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};
use oxc_transformer_plugins::ModuleRunnerTransform;

/// Allocate `size` bytes in linear memory; the JS host fills it, then frees it via
/// [`nb_dealloc`].
#[no_mangle]
pub extern "C" fn nb_alloc(size: usize) -> *mut u8 {
    let mut buf: Vec<u8> = Vec::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Free a buffer from [`nb_alloc`] or a transform result. `size` = exact length.
///
/// # Safety
/// `ptr`/`size` must name a live allocation from this module.
#[no_mangle]
pub unsafe extern "C" fn nb_dealloc(ptr: *mut u8, size: usize) {
    drop(Vec::from_raw_parts(ptr, 0, size));
}

/// Pack an owned output into the ABI return: high 32 bits = pointer, low 32 =
/// length. The JS host copies `len` bytes then calls [`nb_dealloc`].
fn ret(v: Vec<u8>) -> u64 {
    let boxed = v.into_boxed_slice();
    let len = boxed.len() as u64;
    let ptr = Box::into_raw(boxed) as *mut u8 as u64;
    (ptr << 32) | len
}

// oxc emits Vite's runner hook names (`__vite_ssr_import__`, …); the guest binds
// WorkerOS's own — these are internal identifiers, no Vite involved.
fn rename_hooks(code: String) -> String {
    code.replace("__vite_ssr_", "__workeros_")
}

/// Transform ESM `src` into module-runner JS. `module_flag != 0` treats the input
/// as an ES module (the only mode used today).
pub fn transform(src: &str) -> String {
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, src, SourceType::mjs()).parse();
    let mut program = ret.program;
    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
    ModuleRunnerTransform::new().transform(&allocator, &mut program, scoping);
    rename_hooks(Codegen::new().build(&program).code)
}

/// Strip TypeScript from `src` — the full transform, not just type erasure: `enum`,
/// `namespace`, and constructor parameter properties are lowered to their runtime
/// JS, and type-only `import`/`export` are elided. No type *checking* (that needs
/// `tsc`); this only produces the JS the engine can run. `tsx` selects the JSX
/// dialect's parse rules. Shared by both TS entry points below.
fn strip_types<'a>(allocator: &'a Allocator, src: &'a str, tsx: bool) -> oxc::ast::ast::Program<'a> {
    let source_type = if tsx { SourceType::tsx() } else { SourceType::ts() };
    let mut program = Parser::new(allocator, src, source_type).parse().program;
    // `with_enum_eval` is required for the transformer to lower `enum` (it constant-
    // folds member initializers); without it the TS enum pass panics.
    let scoping = SemanticBuilder::new()
        .with_enum_eval(true)
        .build(&program)
        .semantic
        .into_scoping();
    // A path with the matching extension so the transformer picks the TS pipeline.
    let path = if tsx { Path::new("module.tsx") } else { Path::new("module.ts") };
    Transformer::new(allocator, path, &TransformOptions::default())
        .build_with_scoping(scoping, &mut program);
    program
}

/// TypeScript **ESM** → module-runner JS: strip types, then apply the same
/// import/export → live-binding rewrite as [`transform`], so a `.ts`/`.mts`
/// module loads through the guest runner (cycles + `require(esm)` included).
pub fn transform_ts(src: &str, tsx: bool) -> String {
    let allocator = Allocator::default();
    let mut program = strip_types(&allocator, src, tsx);
    // The AST is plain JS now; rebuild scoping for the module-runner transform.
    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
    ModuleRunnerTransform::new().transform(&allocator, &mut program, scoping);
    rename_hooks(Codegen::new().build(&program).code)
}

/// TypeScript **CJS** → plain JS: strip types only, leaving `require`/`module.exports`
/// intact for the CommonJS evaluator (`.cts`, or `.ts` in a `"type":"commonjs"` scope).
pub fn strip_ts(src: &str, tsx: bool) -> String {
    let allocator = Allocator::default();
    let program = strip_types(&allocator, src, tsx);
    Codegen::new().build(&program).code
}

/// Transform the UTF-8 source at `ptr`/`len`; returns packed pointer/length of the
/// transformed UTF-8 JS.
///
/// # Safety: `ptr`/`len` must name a readable UTF-8 input buffer in linear memory.
#[no_mangle]
pub unsafe extern "C" fn nb_transform(ptr: *const u8, len: usize) -> u64 {
    let src = core::slice::from_raw_parts(ptr, len);
    let src = core::str::from_utf8_unchecked(src);
    ret(transform(src).into_bytes())
}

/// TypeScript ESM → module-runner JS (strip types + import/export rewrite).
/// `tsx != 0` parses the JSX dialect.
///
/// # Safety: `ptr`/`len` must name a readable UTF-8 input buffer in linear memory.
#[no_mangle]
pub unsafe extern "C" fn nb_transform_ts(ptr: *const u8, len: usize, tsx: u32) -> u64 {
    let src = core::str::from_utf8_unchecked(core::slice::from_raw_parts(ptr, len));
    ret(transform_ts(src, tsx != 0).into_bytes())
}

/// TypeScript CJS → plain JS (strip types only, keep require/module.exports).
/// `tsx != 0` parses the JSX dialect.
///
/// # Safety: `ptr`/`len` must name a readable UTF-8 input buffer in linear memory.
#[no_mangle]
pub unsafe extern "C" fn nb_strip_ts(ptr: *const u8, len: usize, tsx: u32) -> u64 {
    let src = core::str::from_utf8_unchecked(core::slice::from_raw_parts(ptr, len));
    ret(strip_ts(src, tsx != 0).into_bytes())
}

#[cfg(test)]
mod tests {
    use super::{strip_ts, transform, transform_ts};

    #[test]
    fn cyclic_pair_gets_live_bindings() {
        let a = "import { b } from './b.js';\nexport function a() { return b(); }";
        let out = transform(a);
        // import use rewritten to a live property read; export is a getter.
        assert!(out.contains("__workeros_import__(\"./b.js\""), "import: {out}");
        assert!(out.contains("__workeros_import_0__.b"), "live import use: {out}");
        assert!(out.contains("__workeros_exports__"), "export getter: {out}");
        assert!(!out.contains("vite"), "no vite branding: {out}");
    }

    #[test]
    fn ts_esm_strips_types_and_rewrites_imports() {
        let src = "import type { T } from './t';\nimport { v } from './v.js';\n\
                   export const x: number = v as number;\nlet y: string = 'hi';";
        let out = transform_ts(src, false);
        // type-only import elided; value import rewritten to a runner call.
        assert!(!out.contains("./t"), "type-only import not elided: {out}");
        assert!(out.contains("__workeros_import__(\"./v.js\""), "value import: {out}");
        assert!(!out.contains(": number") && !out.contains(": string"), "types not stripped: {out}");
        assert!(out.contains("__workeros_exports__"), "export getter: {out}");
    }

    #[test]
    fn ts_cjs_strip_only_keeps_require_and_lowers_enum() {
        let src = "const os = require('os');\nenum Color { Red, Green }\n\
                   export const c: Color = Color.Red;\nmodule.exports = { c };";
        let out = strip_ts(src, false);
        assert!(out.contains("require("), "require preserved: {out}");
        assert!(out.contains("module.exports"), "module.exports preserved: {out}");
        // enum is not erasable — it must be lowered to runtime JS, not dropped.
        assert!(out.contains("Color"), "enum lowered: {out}");
        assert!(!out.contains(": Color"), "type annotation not stripped: {out}");
        // strip-only: no module-runner rewrite.
        assert!(!out.contains("__workeros_import__"), "should not rewrite to runner: {out}");
    }
}
