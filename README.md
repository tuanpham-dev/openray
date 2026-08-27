# OpenRay

A Raycast-style command palette and launcher, built on Tauri 2. The native
platform is a slim shell — search/frecency, SQLite storage, global hotkeys,
window/paste/clipboard OS adapters, data import/export, and a `@raycast/api`-compatible
extension runtime — and every feature (app search rows aside) is an
extension running on that runtime: quicklinks, snippets, system commands,
window management, switch windows, script commands, the calculator, translate,
notes, AI (chat/Quick AI/commands/agents/MCP), clipboard history, screenshots,
and menu-bar search all ship as built-in extensions alongside whatever a user
installs from the [raycast/extensions](https://github.com/raycast/extensions)
store. See `plans/refactor-extension-platform.md` for the full design and
build history of this architecture (superseding the earlier
`plans/raycast-clone-tauri.md`).

## Architecture

```
┌────────────────────────── Rust platform (4 enforced layers) ─────────────────────────┐
│ api/        thin Tauri commands: search, settings, transfer, extension mgmt, bridge  │
│ application/ palette search+frecency · CommandRegistry (static+dynamic+inline rows)  │
│              extensions registry · import/export engine · hotkey dispatch            │
│ domain/     Command, RootRow, manifest types, ports (PasteInjector, WindowControl,   │
│              OcrEngine, ClipboardSource, MenuSource) · crate Error enum              │
│ infrastructure/ db · settings · windows(main/settings/ext-owned) · hotkeys(locked)   │
│              clipboard watcher · OCR/ffmpeg/XDND/X11 adapters · extension host proc  │
└──────────────┬────────────────────────────────────────────────┬──────────────────────┘
        JSON-RPC over stdio                              ui commits / events
               ▼                                                ▼
┌── Node sidecar (extension host) ──┐            ┌── webview (apps/desktop) ──────────┐
│ multi-command mounts + unmount    │            │ palette shell + TreeRenderer        │
│ @openray/extras shim (Raycast superset) │            │  (List/Grid/Detail/Form/Markdown-   │
│ first-party + store-installed     │            │   Editor) · settings window         │
│ extensions, full Node (fetch,     │            │ extension-owned windows host the    │
│ child_process, fs) for 1st-party  │            │  same TreeRenderer                  │
└───────────────────────────────────┘            └────────────────────────────────────┘
```

The Rust platform owns windowing, hotkeys, search orchestration, the
extension host process, the bridge, import/export, settings, and the OS adapters
features reach through the bridge (clipboard images/paste injection, window
control, selected text, confirm dialogs, and queries against platform-owned
data like clipboard history, the screenshot index, and menu bars). Extensions
own all feature logic and UI description — first-party ones are trusted Node
code with the full runtime available directly (no bridge round-trip for
`fetch`/`child_process`/`fs`); store-installed ones run against the
`@raycast/api`-compatible subset. The webview renders UI trees the extension
host streams over as commits and hosts the palette shell plus any
extension-owned secondary windows (Notes, AI chat) through the same renderer.
Feature data lives in `extension_storage` (carried by Import/Export, per
`(extension_id, key)`, last-writer-wins); platform-owned data (clipboard
history, the screenshot index, usage/frecency, settings) stays in native
SQLite tables.

## Development

```sh
pnpm install
pnpm fetch:node-sidecar   # fetches the Node runtime the extension host sidecar needs
pnpm dev                  # tauri dev
```

The app icon's source of truth is `src-tauri/icons/icon.svg` — the same
bolt the webview ships as its favicon, on a filled tile. After editing it,
rasterize and regenerate the whole PNG/ICO/ICNS set:

```sh
magick -background none src-tauri/icons/icon.svg -resize 1024x1024 /tmp/openray-icon.png
pnpm tauri icon /tmp/openray-icon.png
rm -rf src-tauri/icons/android src-tauri/icons/ios src-tauri/icons/64x64.png
```

(the last line drops output for the mobile targets and a size this project
doesn't bundle — see `tauri.conf.json`'s `bundle.icon`).

`pnpm build` runs a full `tauri build`; CI (`.github/workflows/build.yml`)
runs it across all three OSes on a tagged push and uploads installers.

### Extension Import/Export

An extension opts into Settings → Import / Export by declaring an `export`
block in its manifest and shipping the two hooks it names:

```jsonc
// package.json
"export": {
  "title": "Quicklinks",                 // the checkbox label
  "description": "Your saved quicklinks", // optional, shown beside it
  "entry": "export"                       // optional, defaults to "export"
}
```

```ts
// src/export.ts
export const exportVersion = 1                      // optional, yours to define
export async function exportData(): Promise<unknown>
export async function importData(data: unknown, version: unknown): Promise<void>
```

The declaration is read from the manifest at registration, so the pane can
list the extension without starting it; the hooks are only called when the
user actually exports or imports. Whatever `exportData` returns is stored
verbatim under the extension's id and handed back to `importData`
unchanged — the host never interprets it, so the payload shape and its
versioning are entirely the extension's own.

Three rules worth knowing:

- **Keep both hooks async, and yield.** Every extension shares one Node
  process. The host tells a slow export from a hung one by pinging that
  process, so synchronous CPU work blocks the probe and gets the export
  treated as a hang.
- **Never return secrets.** Nothing filters `exportData`'s return value.
  API keys and tokens belong under a `secret:`-prefixed storage key, which
  the host's own export already refuses (migration 0026), and should be
  excluded from your payload too.
- **Import adds and updates; it does not wipe.** Restore under the original
  keys so re-importing the same file overwrites rather than duplicating,
  and leave entries the file doesn't mention alone.

An extension's own data reaches the file *only* through these hooks — the
host no longer exports `extension_storage` generically — so an extension
without them contributes nothing to an export.

## Platform notes & manual QA checklist

OpenRay's core logic (search, frecency, SQLite storage, the extension
runtime) is platform-independent and covered by `cargo test`. The pieces
below are genuinely platform-specific — window activation behavior, global
hotkey registration, and OS-level input injection — and some of them can
only be confirmed on real hardware. Each item is marked:

- **verified-in-CI** — covered by an automated test that runs on every push.
- **verified-manually** — confirmed by hand on real hardware; see the date/build.
- **known-gap** — implemented and type-checked (or code-reviewed) but not
  yet confirmed to behave correctly at runtime on that platform. This
  project's development sandbox is Linux/x86_64 with no macOS, Windows, or
  Wayland desktop session available, so "known-gap" here specifically means
  "compiles and passes local review, needs a real machine to confirm."

### macOS

| Item | Status | Notes |
| --- | --- | --- |
| App scanning (`/Applications`, `~/Applications`, `Info.plist` parsing) | verified-in-CI | `application::app_provider` tests + real `.icns→.png` conversion path via `sips`, cross-compile-checked. |
| App launch via `open -a` | known-gap | Logic is a single `Command::new("open")` call; not exercised against a real bundle. |
| Non-activating panel (palette never steals focus from the app you were in) | known-gap | `infrastructure/platform/macos_panel.rs` converts the palette window to an `NSPanel` (`tauri-nspanel`) with `can_become_key_window: true, can_become_main_window: false`. Cross-compile-checked (`cargo check --target aarch64-apple-darwin`) but never run — needs a real Mac to confirm the previously-focused app truly keeps focus, and that `WindowEvent::Focused(false)` still fires on the converted panel (the hide-on-blur behavior in `lib.rs` depends on it). |
| Paste injection lands in the right app | known-gap | Directly depends on the panel item above — see `docs/paste-injection-ordering` fix in git history (hide-before-paste) and the panel's whole reason for existing. |
| Accessibility permission prompt | known-gap | `infrastructure/platform/macos_accessibility.rs` calls `AXIsProcessTrustedWithOptions` with the prompt option before every keystroke-injection attempt; falls back to `PasteOutcome::CopiedOnly` if not (yet) trusted. Cross-compile-checked; the actual system dialog and its System Settings deep-link have not been seen on a real Mac. |
| Cmd+Space default hotkey | verified-in-CI | `infrastructure::settings::tests::default_hotkey_matches_this_platform_convention` — defaults to `Cmd+Space` on macOS, `Alt+Space` elsewhere, since "Cmd" only means the Mac modifier (see `hotkey.rs`). Actual registration/conflict with system Spotlight: known-gap. |
| Dock icon hidden (`ActivationPolicy::Accessory`) | known-gap | Set once in `lib.rs`'s setup; cross-compile-checked only. |
| Import / Export (file dialogs, encryption) | known-gap | `application::transfer` is pure Rust file I/O, SQLite, and encryption with no macOS-specific code; the save/open dialogs come from `tauri-plugin-dialog`. Verified end-to-end on Linux; cross-compile-checked for macOS but the native dialogs have not been opened on a real Mac. |

### Windows

| Item | Status | Notes |
| --- | --- | --- |
| App scanning (`.lnk` shortcuts under Start Menu) | verified-in-CI | Cross-compile-checked (`cargo check --target x86_64-pc-windows-msvc`); real shortcut-resolution behavior via `ShellExecuteW` untested. |
| Focus-stealing workaround on show | known-gap | `infrastructure/platform/windows_focus.rs` does the standard `AttachThreadInput` dance before `SetForegroundWindow` so showing from the tray icon or a single-instance re-launch (not just a hotkey press) reliably takes focus — Windows' foreground-lock heuristic otherwise silently ignores those. Cross-compile-checked, never run. |
| Hotkey conflicts with Win-key combos | known-gap (documented) | `tauri-plugin-global-shortcut` can't bind combos the shell reserves (`Win+*` almost entirely, some `Alt+*`). The default `Alt+Space` avoids the worst of these, but a user-chosen hotkey can silently fail to register — there's no in-app conflict detection yet. If rebinding a hotkey appears to do nothing, try a combo starting with `Ctrl` or `Alt` instead of `Win`. |
| Paste injection (`enigo` Ctrl+V simulation) | known-gap | No Accessibility-style permission gate on Windows, but untested on real hardware. |
| Import / Export (file dialogs, encryption) | known-gap | Core engine (export/merge/apply, encryption, file format) is pure Rust with no Windows-specific code — verified end-to-end on Linux. Nothing is cached to disk: the passphrase-derived key lives only for the duration of one export or import, so the old sync feature's `#[cfg(unix)]`-only key-file permissions gap no longer applies. Cross-compile-checked; the native dialogs are untested on real hardware. |

### Linux — X11

| Item | Status | Notes |
| --- | --- | --- |
| App scanning (`.desktop` file parsing, XDG dirs) | verified-in-CI | Runs natively in this project's dev/CI sandbox. |
| Global hotkey (`tauri-plugin-global-shortcut`) | verified-in-CI | Same code path as Windows/macOS's non-Wayland branch; exercised by the existing test suite's process-level tests, not a real X11 key-grab. |
| Paste injection | verified-in-CI (unit-level) | `SystemPasteInjector` logic covered; real keystroke delivery to another app untested here (no display in this sandbox). |
| Import / Export (file format, encryption, merge) | verified-in-CI + known-gap (UI) | The data path is covered end-to-end by `application::transfer`'s own tests over real migrated schemas: an encrypted export round-trips and its payload is unreadable without the passphrase, an unencrypted export is plain readable JSON, a wrong passphrase is rejected distinctly from a corrupted or non-export file, an unfamiliar `version` still imports (best-effort — `apply_record` skips kinds it doesn't know), clipboard export carries text entries but never image entries, an unchecked category is absent from the file, importing an older export does not resurrect something deleted since (and a newer one still wins), and re-importing the same file is a no-op. Startup cleanup of the retired sync feature's `sync-device-id`/`sync.key` confirmed against a real launched app. **Known gap:** the pane, the native save/open dialogs, and the passphrase modal have not been exercised on screen — this sandbox's headless WebKitGTK does not render the app's transparent window, so the UI layer is typecheck/lint-clean but visually unverified. |

### Linux — Wayland

| Item | Status | Notes |
| --- | --- | --- |
| Clipboard-only paste fallback (`PasteOutcome::CopiedOnly`) | verified-in-CI | `is_wayland()` (env-based: `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE`) gates `SystemPasteInjector` — Wayland gives no client the ability to synthesize a keystroke into another app, so OpenRay copies to the clipboard and reports that honestly instead of pretending to paste. |
| Global hotkey via XDG portal (`org.freedesktop.portal.GlobalShortcuts`) | known-gap | `infrastructure/wayland_hotkey.rs` binds a shortcut through the portal (triggers the compositor's own bind-confirmation dialog) and listens for `Activated` events to toggle the palette — this is the only way to get a global hotkey on Wayland at all, since compositors don't let clients grab arbitrary keys directly. Compiles and passes local tests (`hotkey_to_xdg_trigger` conversion); the actual portal round-trip has not run against a real compositor (this sandbox has no `xdg-desktop-portal` or session bus). |
| Fallback when the portal is unavailable or declined | verified-in-CI (backend) / known-gap (UX) | On failure, `hotkey-portal-unavailable` is emitted and Settings shows a banner pointing at the single-instance toggle (`tauri-plugin-single-instance` already re-invokes `toggle_palette` — re-running `openray` works as a manual "hotkey"). Emission logic is covered by compilation/type-checking; the actual banner has not been seen rendered against a real failure. |

#### No portal, or the bind dialog was declined?

Bind your desktop environment's own keyboard-shortcut setting to launch (or
re-launch) the `openray` binary — the single-instance plugin means a second
launch just toggles the existing palette instead of opening a duplicate
window.

- **GNOME**: Settings → Keyboard → Keyboard Shortcuts → View and Customize
  Shortcuts → Custom Shortcuts → **+** — Command: `openray` (or the full path
  to the AppImage/installed binary), then assign your preferred key combo.
- **KDE Plasma**: System Settings → Shortcuts → Custom Shortcuts → Edit →
  New → Global Shortcut → Command/URL — set the command to `openray` and bind
  a key combo under the Trigger tab.
- Any other Wayland compositor with its own keybinding config (sway,
  Hyprland, etc.): bind your compositor's `exec`-style keybinding directive
  to run `openray`.

### How macOS/Windows code got verified without those machines

This sandbox is Linux/x86_64 only. Rather than shipping macOS/Windows-specific
Rust with zero verification, every change above was confirmed with
`cargo check --target aarch64-apple-darwin` / `--target x86_64-pc-windows-msvc`
using `zig cc` as a cross C toolchain (needed because `rusqlite`'s bundled
SQLite, `objc2`'s Objective-C build script, and the Windows resource
compiler all require a real C/resource compiler even just to type-check,
not only to link). This catches API-signature and type errors but not
runtime/behavioral bugs — hence "known-gap" rather than "verified" for
anything that depends on actual OS behavior.
