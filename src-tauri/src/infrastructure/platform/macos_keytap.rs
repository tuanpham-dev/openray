//! A global keyboard event tap for snippet auto-expansion on macOS.
//!
//! Why the tap must run on the main thread: decoding a key to its character
//! (`CGEventKeyboardGetUnicodeString`, and TSM layout lookups) calls
//! `TSMGetInputSourceProperty` (Text Services Manager). Modern macOS asserts
//! that TSM runs on the main thread and traps (`SIGTRAP` in
//! `dispatch_assert_queue`) otherwise, as soon as it rebuilds its input-source
//! list. A background-thread event tap therefore crashes — found live while
//! testing auto-expansion — so this installs the tap's source on the main run
//! loop instead.
//!
//! The fix is to install the tap's run-loop source on the **main** run loop,
//! so the callback (and any TSM/`CGEventKeyboardGetUnicodeString` layout
//! lookup it makes) runs where macOS requires. The callback stays cheap —
//! classify + match — and hands the actual expansion off to another thread.
//!
//! Hand-rolled CoreGraphics/CoreFoundation FFI, matching the discipline in
//! `macos_accessibility.rs`, rather than pulling a higher-level crate.

use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::OnceLock;

use tauri::AppHandle;

type CFMachPortRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type CFStringRef = *const c_void;
type CGEventRef = *mut c_void;
type CGEventTapProxy = *mut c_void;

type CGEventTapCallBack =
    extern "C" fn(proxy: CGEventTapProxy, etype: u32, event: CGEventRef, user_info: *mut c_void) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: CGEventTapCallBack,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGEventKeyboardGetUnicodeString(
        event: CGEventRef,
        max_string_length: isize,
        actual_string_length: *mut isize,
        unicode_string: *mut u16,
    );
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFMachPortCreateRunLoopSource(allocator: *const c_void, port: CFMachPortRef, order: isize) -> CFRunLoopSourceRef;
    fn CFRunLoopGetMain() -> CFRunLoopRef;
    fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    static kCFRunLoopCommonModes: CFStringRef;
}

// CGEventTapLocation / placement / options.
const K_CG_HID_EVENT_TAP: u32 = 0;
const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
// CGEventType.
const K_CG_EVENT_KEY_DOWN: u32 = 10;
const K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
// CGEventField.
const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;
// CGEventFlags masks.
const K_CG_EVENT_FLAG_MASK_CONTROL: u64 = 0x0004_0000;
const K_CG_EVENT_FLAG_MASK_COMMAND: u64 = 0x0010_0000;

/// One decoded key-down, handed to the auto-expander's matcher.
pub struct MacKeyEvent {
    /// Virtual keycode (`kVK_*`), for classifying special keys.
    pub keycode: u16,
    /// The first character the key produced under the current layout, if any.
    pub text: Option<char>,
    /// Cmd and Ctrl only: the matcher treats those as chords, while Option
    /// is a typing modifier on macOS layouts and is already reflected in
    /// `text` (see `classify_macos`).
    pub command: bool,
    pub control: bool,
}

type Handler = Box<dyn Fn(MacKeyEvent) + Send + Sync>;

static HANDLER: OnceLock<Handler> = OnceLock::new();
// Kept so the tap can be re-enabled if macOS disables it (timeout / user input).
static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

extern "C" fn tap_callback(_proxy: CGEventTapProxy, etype: u32, event: CGEventRef, _user_info: *mut c_void) -> CGEventRef {
    if etype == K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT || etype == K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT {
        let tap = TAP.load(Ordering::SeqCst);
        if !tap.is_null() {
            unsafe { CGEventTapEnable(tap, true) };
        }
        return event;
    }

    if etype == K_CG_EVENT_KEY_DOWN {
        if let Some(handler) = HANDLER.get() {
            let keycode = unsafe { CGEventGetIntegerValueField(event, K_CG_KEYBOARD_EVENT_KEYCODE) } as u16;
            let flags = unsafe { CGEventGetFlags(event) };

            let mut buf = [0u16; 8];
            let mut actual: isize = 0;
            unsafe { CGEventKeyboardGetUnicodeString(event, buf.len() as isize, &mut actual, buf.as_mut_ptr()) };
            let text = if actual > 0 {
                char::decode_utf16(buf.iter().copied().take(actual as usize)).flatten().find(|c| !c.is_control())
            } else {
                None
            };

            handler(MacKeyEvent {
                keycode,
                text,
                command: flags & K_CG_EVENT_FLAG_MASK_COMMAND != 0,
                control: flags & K_CG_EVENT_FLAG_MASK_CONTROL != 0,
            });
        }
    }

    event
}

/// Installs the keyboard tap on the main run loop. Idempotent: a second call
/// is a no-op once the handler is set. Must be able to reach the app's main
/// thread, so it dispatches setup through `run_on_main_thread`. Returns an
/// error only if the handler was already installed (so the caller doesn't
/// double-start); tap-creation failure (e.g. permission) is reported by the
/// tap simply never delivering, the same honesty contract as elsewhere.
pub fn start<R: tauri::Runtime>(app: &AppHandle<R>, handler: Handler) -> Result<(), String> {
    if HANDLER.set(handler).is_err() {
        return Err("macOS key tap already started".into());
    }

    let _ = app.run_on_main_thread(move || unsafe {
        let mask: u64 = 1u64 << K_CG_EVENT_KEY_DOWN;
        let tap = CGEventTapCreate(
            K_CG_HID_EVENT_TAP,
            K_CG_HEAD_INSERT_EVENT_TAP,
            K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
            mask,
            tap_callback,
            std::ptr::null_mut(),
        );
        if tap.is_null() {
            log::warn!("auto-expand: CGEventTapCreate returned null — keystroke tap not installed (grant Accessibility)");
            return;
        }
        TAP.store(tap, Ordering::SeqCst);

        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() {
            log::warn!("auto-expand: CFMachPortCreateRunLoopSource returned null");
            return;
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        log::info!("auto-expand: macOS keystroke tap installed on the main run loop");
    });

    Ok(())
}

