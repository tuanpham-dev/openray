//! Prompts for macOS Accessibility permission the first time OpenRay needs to
//! synthesize a keystroke (`enigo`, used by `SystemPasteInjector` — see
//! infrastructure/paste.rs). Without this permission, `enigo`'s CGEvent
//! calls on macOS silently do nothing; there is no error to catch and no
//! automatic system prompt unless the app explicitly asks for one via
//! `AXIsProcessTrustedWithOptions`, which is what this wraps.
//!
//! Also home to `AXElement`, a small owned wrapper around `AXUIElementRef`
//! used by Navigation's window list and menu-bar backends (`window_list`/
//! `menu_bar`'s `macos.rs`) — both need the same handful of AX operations
//! (read an app's windows, walk a menu tree, press a button), so the FFI
//! and CoreFoundation memory-management bookkeeping lives in one place.
//! Worked from the documented, decades-stable `ApplicationServices`/
//! `CoreFoundation` C APIs directly rather than through `objc2-app-kit`
//! (which has no AX bindings) — unverified by a compiler on this dev
//! machine (Linux), so kept deliberately close to the plain C signatures
//! rather than something more "ergonomic" that's harder to eyeball-check.

use std::ffi::{c_void, CStr};

use objc2_core_foundation::{CFBoolean, CFDictionary, CFRetained, CFString};

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> *mut c_void;
    fn AXUIElementCopyAttributeValue(element: *mut c_void, attribute: *const c_void, value: *mut *mut c_void) -> i32;
    fn AXUIElementSetAttributeValue(element: *mut c_void, attribute: *const c_void, value: *const c_void) -> i32;
    fn AXUIElementPerformAction(element: *mut c_void, action: *const c_void) -> i32;
    // AXValue wraps a CGPoint/CGSize for the AXPosition/AXSize attributes
    // Window Management reads and writes — part of the same
    // ApplicationServices/HIServices header as the AXUIElement calls above,
    // no separate framework needed. `the_type` is an `AXValueType`;
    // `kAXValueCGPointType = 1`, `kAXValueCGSizeType = 2`.
    fn AXValueCreate(the_type: i32, value_ptr: *const c_void) -> *mut c_void;
    fn AXValueGetValue(value: *const c_void, the_type: i32, value_ptr: *mut c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: *const c_void);
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFGetTypeID(cf: *const c_void) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFArrayGetCount(array: *const c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *const c_void, idx: isize) -> *const c_void;
    fn CFBooleanGetValue(boolean: *const c_void) -> bool;
    fn CFStringGetLength(s: *const c_void) -> isize;
    fn CFStringGetCString(s: *const c_void, buffer: *mut i8, buffer_size: isize, encoding: u32) -> bool;
}

/// `kCFStringEncodingUTF8`.
const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

const K_AX_VALUE_CGPOINT_TYPE: i32 = 1;
const K_AX_VALUE_CGSIZE_TYPE: i32 = 2;

/// Layout-compatible with Apple's `CGPoint` (two `CGFloat`s, `f64` on
/// 64-bit) — passed by raw pointer to/from `AXValueCreate`/`AXValueGetValue`,
/// which don't care about the type name, only the memory layout.
#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

/// Layout-compatible with Apple's `CGSize`.
#[repr(C)]
struct CGSize {
    width: f64,
    height: f64,
}

/// Returns whether OpenRay is currently trusted for Accessibility, prompting
/// the user with the system's own "OpenRay would like to control this
/// computer" dialog (which links straight to the right System Settings
/// pane) if it isn't. Safe to call repeatedly — macOS only shows the dialog
/// once per app per permission state, so this is meant to be called right
/// before the first paste-injection attempt rather than gated behind extra
/// bookkeeping here.
pub fn ensure_trusted_with_prompt() -> bool {
    let key = CFString::from_str("AXTrustedCheckOptionPrompt");
    let value = CFBoolean::new(true);
    let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[key.as_ref()], &[value]);

    unsafe { AXIsProcessTrustedWithOptions(CFRetained::as_ptr(&options).as_ptr().cast()) }
}

/// A cheap, non-prompting trust check — safe to call from a hot path like
/// search's per-keystroke `commands()` (Navigation's `available()`), unlike
/// `ensure_trusted_with_prompt`, which re-triggers the permission dialog
/// on every call while untrusted.
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

fn cf_string_to_owned(value: *const c_void) -> Option<String> {
    let len = unsafe { CFStringGetLength(value) };
    // Worst-case UTF-8 expansion per UTF-16 code unit is 3 bytes, plus the
    // NUL terminator `CFStringGetCString` writes.
    let capacity = (len * 3 + 1).max(1) as usize;
    let mut buf = vec![0i8; capacity];
    let ok = unsafe { CFStringGetCString(value, buf.as_mut_ptr(), capacity as isize, CF_STRING_ENCODING_UTF8) };
    if !ok {
        return None;
    }
    let cstr = unsafe { CStr::from_ptr(buf.as_ptr()) };
    Some(cstr.to_string_lossy().into_owned())
}

/// An owned `AXUIElementRef` — releases its CoreFoundation reference on
/// drop. Every accessor is best-effort: a missing/mistyped attribute or a
/// stale element (the underlying app/window closed) just yields `None`/
/// empty, matching the rest of Navigation's "best-effort, never surfaces
/// as an error" philosophy.
pub struct AXElement(*mut c_void);

// AXUIElementRef is documented as safe to use from any thread as long as
// calls into it aren't concurrent with each other, which every caller
// here already satisfies (each element used within one synchronous
// command handler).
unsafe impl Send for AXElement {}

impl AXElement {
    pub fn for_application(pid: i32) -> Option<Self> {
        let el = unsafe { AXUIElementCreateApplication(pid) };
        (!el.is_null()).then_some(Self(el))
    }

    fn copy_attribute_raw(&self, name: &str) -> Option<*mut c_void> {
        let key = CFString::from_str(name);
        let key_ptr = CFRetained::as_ptr(&key).as_ptr().cast();
        let mut value: *mut c_void = std::ptr::null_mut();
        let err = unsafe { AXUIElementCopyAttributeValue(self.0, key_ptr, &mut value) };
        (err == 0 && !value.is_null()).then_some(value)
    }

    /// A string-typed attribute, e.g. `AXTitle`.
    pub fn attribute_string(&self, name: &str) -> Option<String> {
        let value = self.copy_attribute_raw(name)?;
        let result = (unsafe { CFGetTypeID(value) } == unsafe { CFStringGetTypeID() }).then(|| cf_string_to_owned(value)).flatten();
        unsafe { CFRelease(value) };
        result
    }

    /// A boolean-typed attribute, e.g. `AXEnabled`.
    pub fn attribute_bool(&self, name: &str) -> Option<bool> {
        let value = self.copy_attribute_raw(name)?;
        let result = (unsafe { CFGetTypeID(value) } == unsafe { CFBooleanGetTypeID() }).then(|| unsafe { CFBooleanGetValue(value) });
        unsafe { CFRelease(value) };
        result
    }

    /// An element-typed attribute, e.g. `AXCloseButton` or `AXMenuBar`.
    /// `AXUIElementCopyAttributeValue`'s "copy" already hands us an owned
    /// reference, so no extra retain is needed here.
    pub fn attribute_element(&self, name: &str) -> Option<AXElement> {
        self.copy_attribute_raw(name).map(AXElement)
    }

    /// An array-of-elements attribute, e.g. `AXWindows` or `AXChildren`.
    /// Each returned element is individually retained before the backing
    /// array is released — the array owns its own retain on each element,
    /// which would otherwise be dropped along with it.
    pub fn attribute_elements(&self, name: &str) -> Vec<AXElement> {
        let Some(value) = self.copy_attribute_raw(name) else { return Vec::new() };
        if unsafe { CFGetTypeID(value) } != unsafe { CFArrayGetTypeID() } {
            unsafe { CFRelease(value) };
            return Vec::new();
        }

        let count = unsafe { CFArrayGetCount(value) }.max(0);
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let item = unsafe { CFArrayGetValueAtIndex(value, i) };
            if !item.is_null() {
                unsafe { CFRetain(item) };
                out.push(AXElement(item as *mut c_void));
            }
        }
        unsafe { CFRelease(value) };
        out
    }

    /// Triggers an action, e.g. `AXPress` or `AXRaise`.
    pub fn perform_action(&self, action: &str) -> bool {
        let key = CFString::from_str(action);
        let key_ptr = CFRetained::as_ptr(&key).as_ptr().cast();
        unsafe { AXUIElementPerformAction(self.0, key_ptr) == 0 }
    }

    /// A point-typed attribute, e.g. `AXPosition` — the top-left corner in
    /// AX's global (top-left-origin) screen coordinates.
    pub fn attribute_point(&self, name: &str) -> Option<(f64, f64)> {
        let value = self.copy_attribute_raw(name)?;
        let mut point = CGPoint { x: 0.0, y: 0.0 };
        let ok = unsafe { AXValueGetValue(value, K_AX_VALUE_CGPOINT_TYPE, (&mut point as *mut CGPoint).cast()) };
        unsafe { CFRelease(value) };
        ok.then_some((point.x, point.y))
    }

    /// A size-typed attribute, e.g. `AXSize`.
    pub fn attribute_size(&self, name: &str) -> Option<(f64, f64)> {
        let value = self.copy_attribute_raw(name)?;
        let mut size = CGSize { width: 0.0, height: 0.0 };
        let ok = unsafe { AXValueGetValue(value, K_AX_VALUE_CGSIZE_TYPE, (&mut size as *mut CGSize).cast()) };
        unsafe { CFRelease(value) };
        ok.then_some((size.width, size.height))
    }

    fn set_attribute_raw(&self, name: &str, value: *const c_void) -> bool {
        let key = CFString::from_str(name);
        let key_ptr = CFRetained::as_ptr(&key).as_ptr().cast();
        unsafe { AXUIElementSetAttributeValue(self.0, key_ptr, value) == 0 }
    }

    /// Writes `AXPosition`. Returns whether the write was accepted — a
    /// resizable-but-not-movable window (rare) or a stale element both
    /// degrade to `false` rather than panicking.
    pub fn set_position(&self, x: f64, y: f64) -> bool {
        let point = CGPoint { x, y };
        let value = unsafe { AXValueCreate(K_AX_VALUE_CGPOINT_TYPE, (&point as *const CGPoint).cast()) };
        if value.is_null() {
            return false;
        }
        let ok = self.set_attribute_raw("AXPosition", value);
        unsafe { CFRelease(value) };
        ok
    }

    /// Writes `AXSize`.
    pub fn set_size(&self, width: f64, height: f64) -> bool {
        let size = CGSize { width, height };
        let value = unsafe { AXValueCreate(K_AX_VALUE_CGSIZE_TYPE, (&size as *const CGSize).cast()) };
        if value.is_null() {
            return false;
        }
        let ok = self.set_attribute_raw("AXSize", value);
        unsafe { CFRelease(value) };
        ok
    }

    /// Writes a boolean-typed attribute, e.g. `AXFullScreen`.
    pub fn set_attribute_bool(&self, name: &str, flag: bool) -> bool {
        let value = CFBoolean::new(flag);
        let value_ptr = (value as *const CFBoolean).cast();
        self.set_attribute_raw(name, value_ptr)
    }
}

impl Drop for AXElement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}
