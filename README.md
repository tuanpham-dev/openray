# OpenRay

A Raycast-style command palette and launcher, built on Tauri 2. The native
platform is a slim shell — search/frecency, SQLite storage, global hotkeys,
window/paste/clipboard OS adapters, data import/export, and a `@raycast/api`-compatible
extension runtime — and every feature (app search rows aside) is an
extension running on that runtime: quicklinks, snippets, system commands,
window management, switch windows, script commands, the calculator, translate,
notes, AI (chat/Quick AI/commands/agents/MCP), clipboard history, screenshots,
and menu-bar search all ship as built-in extensions alongside whatever a user
installs — from a registry (via the Store command), from a prebuilt `.orx`
archive, from a local folder they are developing, or straight from the
[raycast/extensions](https://github.com/raycast/extensions) monorepo.
See `plans/refactor-extension-platform.md` for the full design and
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

The tray icon is separate, and monochrome on every platform: the bare bolt,
in solid black (`src-tauri/icons/tray.svg`) and solid white
(`tray-inverted.svg`). macOS is handed the black one as a *template* image
and recolours it itself for a light or dark menu bar; Linux and Windows draw
the bitmap as given, so `tray::apply_system_theme` picks between the two by
desktop theme and re-picks when it changes. After editing either SVG:

```sh
magick -background none src-tauri/icons/tray.svg -resize 72x72 PNG32:src-tauri/icons/tray@2x.png
magick -background none src-tauri/icons/tray-inverted.svg -resize 72x72 PNG32:src-tauri/icons/tray-inverted@2x.png
```

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

### Writing an extension

Extensions are ordinary folders — a `package.json` manifest and a `src/`
directory — and OpenRay builds them where they sit, so your checkout stays
the only copy.

The quickest start is the **Create Extension** command in the launcher: name
it, pick a template, and the folder is scaffolded, built, and *already
running* — its command is in the launcher before the toast fades. From a
terminal, the same scaffold:

```sh
npx openray create my-extension   # prompts for a template
cd my-extension && npm install
npm run dev                       # == openray develop
```

Both use the same templates (`@openray/extension-template`), named after
Raycast's: Show List, Show Detail, Show List and Detail, Show Typeahead
Results, Submit Form, Show Grid, and Run Script. Raycast's Menu Bar Extra
and AI templates are deliberately absent — those APIs are still stubs here,
so scaffolding them would hand you something that cannot run.

`openray develop` asks the running app to build the folder and watch it.
Its commands appear in the launcher immediately; every save rebuilds and
**hot-reloads** whatever is on screen, and build errors stream to the
terminal instead of vanishing into a log. Settings → Add Extension →
"Choose Folder…" does the same thing without a terminal.

The CLI never compiles anything itself — it drives the app over a local
socket (`~/.config/openray/control-socket` points at it). One build
pipeline serves dev mode, installs, and packing, which is what keeps a dev
build and a shipped build the same artifact. Unix only for now; the
in-app picker works everywhere.

### Running commands from a terminal

The same socket lets you run a command without touching the palette:

```sh
npx openray list                 # id, extension, and mode for every command
npx openray run <id>             # ids look like ext:<extension>:<command>, from the list above
npx openray run <id> --arg name=value   # for a command with arguments
```

A command with no UI of its own (a window preset, a snippet, a system
command) runs headlessly and `run` returns once it's done. A command that
opens a view (Store, Notes, most List/Grid/Form commands) instead brings
the app forward and opens it there, the same as a click or hotkey would —
`run` returns as soon as that's requested, not once the view has actually
rendered. Both `list` and `run` need OpenRay already running, same as
`develop`.

Write against `@raycast/api` (a dev dependency, for types only) or
`@openray/api`; both are mapped onto OpenRay's own implementation at build
time, and `@openray/extras` adds what Raycast has no equivalent for.

### Packaging and registries

An extension packs into a `.orx` archive — a zip carrying the manifest,
prebuilt command bundles, and assets under a top-level `extension/`
directory:

```sh
npx openray pack                          # dist/<name>-<version>.orx
npx openray publish ext-a ext-b --out dist  # + dist/index.json
```

Because archives ship **prebuilt**, installing one needs no git, npm, or
compiler on the user's machine. Packing is where things are checked
instead: the extension must build cleanly, use only APIs this OpenRay
provides (recorded in the archive and re-checked at install), avoid native
binaries and install scripts, and carry a LICENSE if it inlines
third-party code.

A **registry** is nothing more than a directory like the one `publish`
writes — `index.json` plus the archives — served from anywhere static.
There is no backend. Add one under Settings → Add Extension → Registries,
and browse it with the **Store** command.

Every install starts with one already added: **OpenRay Extensions**
(<https://tuanpham-dev.github.io/openray-extensions/>), seeded on first run.
It is an ordinary source with no privileges — remove it in Settings and it
stays removed. Its repository is also the worked example of everything
below: a folder per extension, a Pages workflow, nothing else.

The `openray` CLI is published, so a registry's CI needs no checkout of this
repository:

```sh
npm install --save-dev @openray/cli
```

```yaml
# .github/workflows/pages.yml — publish a registry from a repo of extensions
name: Publish registry
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  build:
    runs-on: ubuntu-latest
    environment: { name: github-pages }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install
      - run: npx openray publish extensions/*/ --out dist
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - uses: actions/deploy-pages@v4
```

Publishing a new version is then a `git push`. `dist/` need not be
committed — CI regenerates it.

Two things to know before running your own registry. Catalog entries may
point `file` at an absolute URL, so a registry that outgrows GitHub Pages'
100 GB/month can keep `index.json` there and move archives to Releases
assets without any app change. And **archives are unsigned**: the catalog's
`sha256` is verified on download, which pins the file to the catalog but
says nothing about who published it. Adding a registry is therefore the
trust decision — extensions run in the extension host with your own
privileges, and with automatic updates on (per-source, default on) new
versions install without asking. Add registries you trust.

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

### Windows

| Item | Status | Notes |
| --- | --- | --- |
| App scanning (`.lnk` shortcuts under Start Menu) | verified-in-CI | Cross-compile-checked (`cargo check --target x86_64-pc-windows-msvc`); real shortcut-resolution behavior via `ShellExecuteW` untested. |
| Focus-stealing workaround on show | known-gap | `infrastructure/platform/windows_focus.rs` does the standard `AttachThreadInput` dance before `SetForegroundWindow` so showing from the tray icon or a single-instance re-launch (not just a hotkey press) reliably takes focus — Windows' foreground-lock heuristic otherwise silently ignores those. Cross-compile-checked, never run. |
| Hotkey conflicts with Win-key combos | known-gap (documented) | `tauri-plugin-global-shortcut` can't bind combos the shell reserves (`Win+*` almost entirely, some `Alt+*`). The default `Alt+Space` avoids the worst of these, but a user-chosen hotkey can silently fail to register — there's no in-app conflict detection yet. If rebinding a hotkey appears to do nothing, try a combo starting with `Ctrl` or `Alt` instead of `Win`. |
| Paste injection (`enigo` Ctrl+V simulation) | known-gap | No Accessibility-style permission gate on Windows, but untested on real hardware. |
| Snippet auto-expansion | known-gap | Same `application/auto_expand.rs` service; a native `WH_KEYBOARD_LL` low-level keyboard hook (`windows_keytap.rs`, on the `windows` crate) listens, `enigo` injects. No extra permission gate. `windows_keytap.rs` type-checks under a mingw cross-compile; the full app targets windows-msvc, and the hook has not been run on real hardware. |
| Import / Export (file dialogs, encryption) | known-gap | Core engine (export/merge/apply, encryption, file format) is pure Rust with no Windows-specific code — verified end-to-end on Linux. Nothing is cached to disk: the passphrase-derived key lives only for the duration of one export or import, so the old sync feature's `#[cfg(unix)]`-only key-file permissions gap no longer applies. Cross-compile-checked; the native dialogs are untested on real hardware. |

### Linux — X11

| Item | Status | Notes |
| --- | --- | --- |
| App scanning (`.desktop` file parsing, XDG dirs) | verified-in-CI | Runs natively in this project's dev/CI sandbox. |
| Global hotkey (`tauri-plugin-global-shortcut`) | verified-in-CI | Same code path as Windows/macOS's non-Wayland branch; exercised by the existing test suite's process-level tests, not a real X11 key-grab. |
| Paste injection | verified-in-CI (unit-level) | `SystemPasteInjector` logic covered; real keystroke delivery to another app untested here (no display in this sandbox). |
| Snippet auto-expansion | known-gap | `application/auto_expand.rs` listens via a native XRecord tap (`linux_keytap.rs`, on `x11rb`'s `record` extension); `AutoExpander::available()` is true only off Wayland, and start fails gracefully into the pane banner if the X server lacks XRecord. `linux_keytap.rs` type-checks against `x11rb`; not exercised against a real X11 key stream in this sandbox. |
| Import / Export (file format, encryption, merge) | verified-in-CI + known-gap (UI) | The data path is covered end-to-end by `application::transfer`'s own tests over real migrated schemas: an encrypted export round-trips and its payload is unreadable without the passphrase, an unencrypted export is plain readable JSON, a wrong passphrase is rejected distinctly from a corrupted or non-export file, an unfamiliar `version` still imports (best-effort — `apply_record` skips kinds it doesn't know), clipboard export carries text entries but never image entries, an unchecked category is absent from the file, importing an older export does not resurrect something deleted since (and a newer one still wins), and re-importing the same file is a no-op. Startup cleanup of the retired sync feature's `sync-device-id`/`sync.key` confirmed against a real launched app. **Known gap:** the pane, the native save/open dialogs, and the passphrase modal have not been exercised on screen — this sandbox's headless WebKitGTK does not render the app's transparent window, so the UI layer is typecheck/lint-clean but visually unverified. |

### Linux — Wayland

| Item | Status | Notes |
| --- | --- | --- |
| Clipboard-only paste fallback (`PasteOutcome::CopiedOnly`) | verified-in-CI | `is_wayland()` (env-based: `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE`) gates `SystemPasteInjector` — Wayland gives no client the ability to synthesize a keystroke into another app, so OpenRay copies to the clipboard and reports that honestly instead of pretending to paste. |
| Global hotkey via XDG portal (`org.freedesktop.portal.GlobalShortcuts`) | known-gap | `infrastructure/wayland_hotkey.rs` binds a shortcut through the portal (triggers the compositor's own bind-confirmation dialog) and listens for `Activated` events to toggle the palette — this is the only way to get a global hotkey on Wayland at all, since compositors don't let clients grab arbitrary keys directly. Compiles and passes local tests (`hotkey_to_xdg_trigger` conversion); the actual portal round-trip has not run against a real compositor (this sandbox has no `xdg-desktop-portal` or session bus). |
| Fallback when the portal is unavailable or declined | verified-in-CI (backend) / known-gap (UX) | On failure, `hotkey-portal-unavailable` is emitted and Settings shows a banner pointing at the single-instance toggle (`tauri-plugin-single-instance` already re-invokes `toggle_palette` — re-running `openray` works as a manual "hotkey"). Emission logic is covered by compilation/type-checking; the actual banner has not been seen rendered against a real failure. |
| Snippet auto-expansion | unsupported | `AutoExpander::available()` returns false on Wayland (env-detected) — no client may observe or synthesize keystrokes into another app, the same constraint that makes paste a `CopiedOnly` fallback. Enabling the toggle emits `snippet-auto-expand-unavailable` and the Snippets pane shows a banner; a keyword still expands from the palette. |

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
