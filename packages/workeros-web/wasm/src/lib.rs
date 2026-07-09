//! wasm-bindgen bindings for the WorkerOS kernel.
//!
//! This crate is the *only* place the Rust kernel touches the browser. It is a
//! thin translation layer: it forwards to `workeros-kernel` and marshals results
//! across the wasm boundary. No kernel logic lives here (INV-2/ADR-004) — if you
//! find yourself making a resolution, VFS, or capability decision in this file,
//! it belongs in `workeros-kernel` instead.

use wasm_bindgen::prelude::*;
use workeros_kernel::Kernel;

/// A booted kernel handle, held by the kernel worker's JS glue.
#[wasm_bindgen]
pub struct WebKernel {
    inner: Kernel,
}

#[wasm_bindgen]
impl WebKernel {
    /// Boot the kernel. The JS glue calls this once when the kernel worker
    /// starts and posts the returned handshake back to the main thread.
    #[wasm_bindgen(js_name = boot)]
    pub fn boot() -> WebKernel {
        let (inner, _handshake) = Kernel::boot();
        WebKernel { inner }
    }

    /// The kernel version string (Phase 0 handshake field).
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> String {
        workeros_kernel::VERSION.to_string()
    }

    /// The ABI identifier the kernel implements (Phase 0 handshake field).
    #[wasm_bindgen(getter)]
    pub fn abi(&self) -> String {
        workeros_kernel::ABI.to_string()
    }

    // Keep `inner` live; Phase 1 grows this into the syscall entry points.
    #[doc(hidden)]
    #[wasm_bindgen(js_name = _touch)]
    pub fn touch(&self) -> bool {
        let _ = &self.inner;
        true
    }
}
