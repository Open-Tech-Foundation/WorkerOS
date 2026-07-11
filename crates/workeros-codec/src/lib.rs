//! WorkerOS codec — a freestanding wasm module that accelerates the hot paths of
//! the guest `node:zlib` / `node:crypto` builtins (DEFLATE and hashing).
//!
//! It carries a **manual pointer/length ABI** (no wasm-bindgen) precisely so the
//! guest can instantiate it *synchronously* — `new WebAssembly.Instance(...)` — and
//! call it from inside Node's synchronous APIs (`gzipSync`, `createHash().digest()`).
//! wasm-bindgen's `init` is async, which those APIs can't await; a raw module with
//! `alloc`/`dealloc` + functions returning a packed `(ptr<<32)|len` avoids all of
//! that. The JS side (`node/wasm-codec.js`) copies bytes in/out of linear memory.
//!
//! Guest code (INV-1): userland acceleration behind stable APIs, with the pure-JS
//! implementations kept as the always-present fallback. The kernel is untouched.

// The exported functions form an internal wasm ABI called only by the trusted JS
// facade (`node/wasm-codec.js`), which upholds the pointer/length contracts. The
// per-function safety contract is documented on `cdc_dealloc`; repeating a `#
// Safety` section on every thin `from_raw_parts` wrapper is noise here.
#![allow(clippy::missing_safety_doc)]

use core::slice;
use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha224, Sha256, Sha384, Sha512};

/// Allocate `size` bytes in the module's linear memory; returns the pointer. The
/// JS host fills it with input, then frees it via [`cdc_dealloc`].
#[no_mangle]
pub extern "C" fn cdc_alloc(size: usize) -> *mut u8 {
    let mut buf: Vec<u8> = Vec::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Free a buffer previously returned by [`cdc_alloc`] or a codec function. `size`
/// must be the buffer's exact byte length (codec outputs are exact-sized boxed
/// slices, and inputs are allocated at exactly `size`).
///
/// # Safety
/// `ptr`/`size` must name a live allocation from this module.
#[no_mangle]
pub unsafe extern "C" fn cdc_dealloc(ptr: *mut u8, size: usize) {
    drop(Vec::from_raw_parts(ptr, 0, size));
}

/// Pack an owned output buffer into the ABI return: high 32 bits = data pointer,
/// low 32 bits = length. The JS host copies `len` bytes then calls `cdc_dealloc`.
fn ret(v: Vec<u8>) -> u64 {
    let boxed = v.into_boxed_slice(); // capacity == len, so dealloc(ptr, len) is exact
    let len = boxed.len() as u64;
    let ptr = Box::into_raw(boxed) as *mut u8 as u64;
    (ptr << 32) | len
}

/// # Safety: `ptr`/`len` must name a readable input buffer in linear memory.
#[no_mangle]
pub unsafe extern "C" fn cdc_deflate(ptr: *const u8, len: usize, level: u8) -> u64 {
    let input = slice::from_raw_parts(ptr, len);
    ret(miniz_oxide::deflate::compress_to_vec(input, level)) // raw DEFLATE (no header)
}

/// Inflate raw DEFLATE. Returns `0` (null pointer) on malformed input so the JS
/// host can surface a proper error.
///
/// # Safety: `ptr`/`len` must name a readable input buffer.
#[no_mangle]
pub unsafe extern "C" fn cdc_inflate(ptr: *const u8, len: usize) -> u64 {
    let input = slice::from_raw_parts(ptr, len);
    match miniz_oxide::inflate::decompress_to_vec(input) {
        Ok(v) => ret(v),
        Err(_) => 0,
    }
}

/// # Safety: `ptr`/`len` must name a readable input buffer.
#[no_mangle]
pub unsafe extern "C" fn cdc_crc32(ptr: *const u8, len: usize) -> u32 {
    crc32(slice::from_raw_parts(ptr, len))
}

/// # Safety: `ptr`/`len` must name a readable input buffer.
#[no_mangle]
pub unsafe extern "C" fn cdc_adler32(ptr: *const u8, len: usize) -> u32 {
    adler32(slice::from_raw_parts(ptr, len))
}

macro_rules! hash_fn {
    ($name:ident, $ty:ty) => {
        /// # Safety: `ptr`/`len` must name a readable input buffer.
        #[no_mangle]
        pub unsafe extern "C" fn $name(ptr: *const u8, len: usize) -> u64 {
            let mut h = <$ty>::new();
            h.update(slice::from_raw_parts(ptr, len));
            ret(h.finalize().to_vec())
        }
    };
}
hash_fn!(cdc_md5, Md5);
hash_fn!(cdc_sha1, Sha1);
hash_fn!(cdc_sha224, Sha224);
hash_fn!(cdc_sha256, Sha256);
hash_fn!(cdc_sha384, Sha384);
hash_fn!(cdc_sha512, Sha512);

// ---- checksums (kept dependency-free, matching the JS + kernel style) -------
fn crc32(data: &[u8]) -> u32 {
    let mut c: u32 = 0xffff_ffff;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    c ^ 0xffff_ffff
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for &byte in chunk {
            a += byte as u32;
            b += a;
        }
        a %= MOD;
        b %= MOD;
    }
    (b << 16) | a
}
