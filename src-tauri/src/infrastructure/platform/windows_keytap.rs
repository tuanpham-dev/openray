//! A global keyboard listener for snippet auto-expansion on Windows.
//!
//! Uses a `WH_KEYBOARD_LL` low-level keyboard hook — the standard way to
//! observe keystrokes system-wide. The hook must be installed from a thread
//! that runs a message loop, so `start` spawns a dedicated thread that installs
//! the hook and pumps messages for the app's lifetime. The hook callback
//! decodes each key-down to a character with `ToUnicodeEx` and hands it to the
//! auto-expander's matcher.
//!
//! Replaces the `rdev` crate on Windows. Injection still goes through `enigo`.
//! Hand-rolled against the `windows` crate (already a dependency), same spirit
//! as the macOS and Linux taps.

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::OnceLock;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardLayout, GetKeyboardState, ToUnicodeEx, VK_CONTROL, VK_MENU};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

/// One decoded key-down handed to the auto-expander's matcher.
pub struct WinKeyEvent {
    /// Virtual-key code (`VK_*`), for classifying special keys.
    pub vk: u16,
    /// The character the key produced under the current layout, if any.
    pub text: Option<char>,
    pub control: bool,
    pub alt: bool,
}

type Handler = Box<dyn Fn(WinKeyEvent) + Send + Sync>;

static HANDLER: OnceLock<Handler> = OnceLock::new();
// The installed hook handle, kept for `CallNextHookEx`.
static HOOK: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // Per the WH_KEYBOARD_LL contract: only act when code == HC_ACTION (0), and
    // always chain to the next hook so input is never swallowed or delayed.
    if code == 0 {
        let msg = wparam.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            if let Some(handler) = HANDLER.get() {
                let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
                let vk = kb.vkCode as u16;

                let mut state = [0u8; 256];
                let _ = unsafe { GetKeyboardState(&mut state) };
                let control = state[VK_CONTROL.0 as usize] & 0x80 != 0;
                let alt = state[VK_MENU.0 as usize] & 0x80 != 0;

                let layout = unsafe { GetKeyboardLayout(0) };
                let mut buf = [0u16; 8];
                // flags = 0; a listen-only decode. `ToUnicodeEx` can disturb
                // dead-key state — an accepted limitation of a keyword matcher.
                let n = unsafe { ToUnicodeEx(vk as u32, kb.scanCode, &state, &mut buf, 0, Some(layout)) };
                let text = if n > 0 {
                    char::decode_utf16(buf.iter().copied().take(n as usize)).flatten().find(|c| !c.is_control())
                } else {
                    None
                };

                handler(WinKeyEvent { vk, text, control, alt });
            }
        }
    }

    let hook = HHOOK(HOOK.load(Ordering::SeqCst) as *mut _);
    unsafe { CallNextHookEx(Some(hook), code, wparam, lparam) }
}

/// Installs the low-level keyboard hook on a dedicated message-pump thread.
/// Idempotent: a second call is refused once the handler is set. The hook
/// callback runs on that thread. If installation fails (rare on Windows —
/// there's no permission gate), it's logged and the tap simply never delivers.
pub fn start(handler: Handler) -> Result<(), String> {
    if HANDLER.set(handler).is_err() {
        return Err("windows key hook already started".into());
    }

    std::thread::spawn(|| unsafe {
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
            Ok(h) => h,
            Err(e) => {
                log::warn!("auto-expand: SetWindowsHookExW failed: {e}");
                return;
            }
        };
        HOOK.store(hook.0 as isize, Ordering::SeqCst);
        log::info!("auto-expand: Windows low-level keyboard hook installed");

        // The hook only fires while this thread pumps messages.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
    });

    Ok(())
}
