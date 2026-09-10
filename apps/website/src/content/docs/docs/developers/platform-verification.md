---
title: Platform verification
description: What is covered by automated tests, what was confirmed by hand, and what is still unverified per platform.
---

Each item below is marked:

- **verified-in-CI** — covered by an automated test that runs on every push.
- **verified-manually** — confirmed by hand on real hardware; see the date and build.
- **known-gap** — implemented and type-checked (or code-reviewed) but not yet confirmed
  to behave correctly at runtime on that platform.

This project's development sandbox is Linux/x86_64 with no macOS, Windows, or Wayland
desktop session available, so "known-gap" specifically means "compiles and passes local
review, needs a real machine to confirm."

OpenRay's core logic — search, frecency, SQLite storage, the extension runtime — is
platform-independent and covered by `cargo test`. The pieces below are genuinely
platform-specific: window activation behaviour, global hotkey registration, and OS-level
input injection.

## macOS

| Item | Status | Notes |
| --- | --- | --- |
| App scanning (`/Applications`, `~/Applications`, `Info.plist` parsing) | verified-in-CI | `application::app_provider` tests + real `.icns→.png` conversion path via `sips`, cross-compile-checked. |
| App launch via `open -a` | known-gap | Logic is a single `Command::new("open")` call; not exercised against a real bundle. |
| Non-activating panel (palette never steals focus from the app you were in) | verified-manually (2026-08-29) | `infrastructure/platform/macos_panel.rs` converts the palette window to an `NSPanel` (`tauri-nspanel`) with `can_become_key_window: true, can_become_main_window: false`. Confirmed on a real Mac: showing the palette (via the global hotkey and via the single-instance relaunch) leaves the previously-focused app frontmost in the menu bar, not OpenRay. Two real bugs were found and fixed getting this far — see the note below the table. `WindowEvent::Focused(false)`/hide-on-blur specifically still untested. |
| Paste injection lands in the right app | known-gap | Directly depends on the panel item above — see `docs/paste-injection-ordering` fix in git history (hide-before-paste) and the panel's whole reason for existing. |
| Accessibility permission prompt | known-gap | `infrastructure/platform/macos_accessibility.rs` calls `AXIsProcessTrustedWithOptions` with the prompt option before every keystroke-injection attempt; falls back to `PasteOutcome::CopiedOnly` if not (yet) trusted. Cross-compile-checked; the actual system dialog and its System Settings deep-link have not been seen on a real Mac. |
| Cmd+Space default hotkey | verified-in-CI + verified-manually (2026-08-29) | `infrastructure::settings::tests::default_hotkey_matches_this_platform_convention` — defaults to `Cmd+Space` on macOS, `Alt+Space` elsewhere, since "Cmd" only means the Mac modifier (see `hotkey.rs`). Registration itself works and the palette does show. Confirmed conflict with system Spotlight: both open simultaneously (Spotlight owns the OS-level binding; OpenRay's global-shortcut hook fires independently) — a user needs to unbind Spotlight's Cmd+Space first, same prerequisite Raycast documents for itself. |
| Dock icon hidden (`ActivationPolicy::Accessory`) | known-gap | Set once in `lib.rs`'s setup; cross-compile-checked only. |
| Import / Export (file dialogs, encryption) | known-gap | `application::transfer` is pure Rust file I/O, SQLite, and encryption with no macOS-specific code; the save/open dialogs come from `tauri-plugin-dialog`. Verified end-to-end on Linux; cross-compile-checked for macOS but the native dialogs have not been opened on a real Mac. |
| Snippet auto-expansion (keystroke listener + in-place insert) | verified-manually (2026-09-03) | `application/auto_expand.rs` matches typed keywords; macOS listens via a hand-rolled `CGEventTap` installed on the **main run loop** (`macos_keytap.rs`) — a background-thread tap crashes because key-to-text decoding calls Text Services APIs macOS asserts must run on the main thread. A match is deleted and replaced by `paste::expand_in_place` (clipboard save/restore + `{cursor}` caret placement); the paste sends the raw V keycode, not `Key::Unicode('v')`, which otherwise aborts in Text Services. Needs **Accessibility** (rdev/enigo's real requirement — the listener and the injection both use it); Input Monitoring is also prompted as a belt-and-suspenders. A snippet using `{selection}` fires a synthetic Cmd+C mid-typing. Confirmed on a real Mac: a keyword expands in place, clipboard preserved, no crash. |

First real macOS run (2026-08-29) turned up bugs `cargo check --target aarch64-apple-darwin` couldn't catch, since cross-compilation type-checks against the target but never links or executes against its runtime:

- **7 compile errors**, all in code introduced after the last time anyone actually built for this target: a `futures-util` dependency scoped to Linux-only but used from cross-platform code, and stale `objc2`/`objc2-vision`/`objc2-app-kit` API usage (a missing `AnyThread` import, a `CFRetained` vs. plain-reference pointer mismatch, one `Retained::into_super` short of the `VNRequest` hierarchy Vision OCR needs, and two `NSScreen::screens()` calls missing the `MainThreadMarker` this `objc2-app-kit` version requires).
- **A startup crash**: `tauri_nspanel::init()` was never registered as a plugin, so the first `WebviewWindowExt::to_panel()` call panicked with `state() called before manage()`. Fixed by adding the plugin, macOS-gated, in `lib.rs`.
- **`cargo test` wouldn't link**: `tauri::generate_context!()` was invoked from four places (production `run()` plus three test modules); the macro embeds a process-wide static and can only expand once per binary — invisible on Linux since Info.plist embedding is a no-op there. Fixed by routing every test call site through one shared `crate::test_context()` helper.
- **A crash on every show/toggle** (hotkey press or single-instance relaunch): `hotkey.rs`'s `dispatch` deliberately runs `HotkeyAction` handlers on a spawned thread — a documented, gdb-verified fix for an X11 deadlock — but `toggle_palette` reaches `macos_panel::show/hide/is_visible`, which call AppKit/`NSPanel` methods directly. AppKit is main-thread-only, and modern macOS hard-crashes (`SIGTRAP`, no catchable panic, nothing printed) rather than warning when that's violated off-thread. The single-instance relaunch path had the same problem — `lib.rs`'s callback calls `toggle_palette` with no thread marshalling at all. Fixed by adding a small `on_main_thread` helper in `macos_panel.rs` that dispatches through `AppHandle::run_on_main_thread` (a no-op if already on the main thread), used by all three functions.

## Windows

| Item | Status | Notes |
| --- | --- | --- |
| App scanning (`.lnk` shortcuts under Start Menu) | verified-in-CI | Cross-compile-checked (`cargo check --target x86_64-pc-windows-msvc`); real shortcut-resolution behavior via `ShellExecuteW` untested. |
| Focus-stealing workaround on show | known-gap | `infrastructure/platform/windows_focus.rs` does the standard `AttachThreadInput` dance before `SetForegroundWindow` so showing from the tray icon or a single-instance re-launch (not just a hotkey press) reliably takes focus — Windows' foreground-lock heuristic otherwise silently ignores those. Cross-compile-checked, never run. |
| Hotkey conflicts with Win-key combos | known-gap (documented) | `tauri-plugin-global-shortcut` can't bind combos the shell reserves (`Win+*` almost entirely, some `Alt+*`). The default `Alt+Space` avoids the worst of these, but a user-chosen hotkey can silently fail to register — there's no in-app conflict detection yet. If rebinding a hotkey appears to do nothing, try a combo starting with `Ctrl` or `Alt` instead of `Win`. |
| Paste injection (`enigo` Ctrl+V simulation) | known-gap | No Accessibility-style permission gate on Windows, but untested on real hardware. |
| Snippet auto-expansion | known-gap | Same `application/auto_expand.rs` service; a native `WH_KEYBOARD_LL` low-level keyboard hook (`windows_keytap.rs`, on the `windows` crate) listens, `enigo` injects. No extra permission gate. `windows_keytap.rs` type-checks under a mingw cross-compile; the full app targets windows-msvc, and the hook has not been run on real hardware. |
| Import / Export (file dialogs, encryption) | known-gap | Core engine (export/merge/apply, encryption, file format) is pure Rust with no Windows-specific code — verified end-to-end on Linux. Nothing is cached to disk: the passphrase-derived key lives only for the duration of one export or import, so the old sync feature's `#[cfg(unix)]`-only key-file permissions gap no longer applies. Cross-compile-checked; the native dialogs are untested on real hardware. |

## Linux — X11

| Item | Status | Notes |
| --- | --- | --- |
| App scanning (`.desktop` file parsing, XDG dirs) | verified-in-CI | Runs natively in this project's dev/CI sandbox. |
| Global hotkey (`tauri-plugin-global-shortcut`) | verified-in-CI | Same code path as Windows/macOS's non-Wayland branch; exercised by the existing test suite's process-level tests, not a real X11 key-grab. |
| Paste injection | verified-in-CI (unit-level) | `SystemPasteInjector` logic covered; real keystroke delivery to another app untested here (no display in this sandbox). |
| Snippet auto-expansion | known-gap | `application/auto_expand.rs` listens via a native XRecord tap (`linux_keytap.rs`, on `x11rb`'s `record` extension); `AutoExpander::available()` is true only off Wayland, and start fails gracefully into the pane banner if the X server lacks XRecord. `linux_keytap.rs` type-checks against `x11rb`; not exercised against a real X11 key stream in this sandbox. |
| Import / Export (file format, encryption, merge) | verified-in-CI + known-gap (UI) | The data path is covered end-to-end by `application::transfer`'s own tests over real migrated schemas: an encrypted export round-trips and its payload is unreadable without the passphrase, an unencrypted export is plain readable JSON, a wrong passphrase is rejected distinctly from a corrupted or non-export file, an unfamiliar `version` still imports (best-effort — `apply_record` skips kinds it doesn't know), clipboard export carries text entries but never image entries, an unchecked category is absent from the file, importing an older export does not resurrect something deleted since (and a newer one still wins), and re-importing the same file is a no-op. Startup cleanup of the retired sync feature's `sync-device-id`/`sync.key` confirmed against a real launched app. **Known gap:** the pane, the native save/open dialogs, and the passphrase modal have not been exercised on screen — this sandbox's headless WebKitGTK does not render the app's transparent window, so the UI layer is typecheck/lint-clean but visually unverified. |

## Linux — Wayland

| Item | Status | Notes |
| --- | --- | --- |
| Clipboard-only paste fallback (`PasteOutcome::CopiedOnly`) | verified-in-CI | `is_wayland()` (env-based: `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE`) gates `SystemPasteInjector` — Wayland gives no client the ability to synthesize a keystroke into another app, so OpenRay copies to the clipboard and reports that honestly instead of pretending to paste. |
| Global hotkey via XDG portal (`org.freedesktop.portal.GlobalShortcuts`) | known-gap | `infrastructure/wayland_hotkey.rs` binds a shortcut through the portal (triggers the compositor's own bind-confirmation dialog) and listens for `Activated` events to toggle the palette — this is the only way to get a global hotkey on Wayland at all, since compositors don't let clients grab arbitrary keys directly. Compiles and passes local tests (`hotkey_to_xdg_trigger` conversion); the actual portal round-trip has not run against a real compositor (this sandbox has no `xdg-desktop-portal` or session bus). |
| Fallback when the portal is unavailable or declined | verified-in-CI (backend) / known-gap (UX) | On failure, `hotkey-portal-unavailable` is emitted and Settings shows a banner pointing at the single-instance toggle (`tauri-plugin-single-instance` already re-invokes `toggle_palette` — re-running `openray` works as a manual "hotkey"). Emission logic is covered by compilation/type-checking; the actual banner has not been seen rendered against a real failure. |
| Snippet auto-expansion | unsupported | `AutoExpander::available()` returns false on Wayland (env-detected) — no client may observe or synthesize keystrokes into another app, the same constraint that makes paste a `CopiedOnly` fallback. Enabling the toggle emits `snippet-auto-expand-unavailable` and the Snippets pane shows a banner; a keyword still expands from the palette. |

## How macOS/Windows code got verified without those machines

This sandbox is Linux/x86_64 only. Rather than shipping macOS/Windows-specific
Rust with zero verification, every change above was confirmed with
`cargo check --target aarch64-apple-darwin` / `--target x86_64-pc-windows-msvc`
using `zig cc` as a cross C toolchain (needed because `rusqlite`'s bundled
SQLite, `objc2`'s Objective-C build script, and the Windows resource
compiler all require a real C/resource compiler even just to type-check,
not only to link). This catches API-signature and type errors but not
runtime/behavioral bugs — hence "known-gap" rather than "verified" for
anything that depends on actual OS behavior.
