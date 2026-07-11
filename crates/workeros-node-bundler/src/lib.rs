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

use oxc::allocator::Allocator;
use oxc::codegen::Codegen;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
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

/// Transform ESM `src` into module-runner JS. `module_flag != 0` treats the input
/// as an ES module (the only mode used today).
pub fn transform(src: &str) -> String {
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, src, SourceType::mjs()).parse();
    let mut program = ret.program;
    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
    ModuleRunnerTransform::new().transform(&allocator, &mut program, scoping);
    // oxc emits Vite's runner hook names (`__vite_ssr_import__`, …); rename them to
    // WorkerOS's own — these are internal identifiers the guest runtime binds, no
    // Vite involved.
    Codegen::new().build(&program).code.replace("__vite_ssr_", "__workeros_")
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

#[cfg(test)]
mod tests {
    use super::transform;

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
}
