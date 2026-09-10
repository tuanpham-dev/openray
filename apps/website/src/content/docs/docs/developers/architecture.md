---
title: Architecture
description: How the Rust platform, the Node extension host, and the webview divide the work.
---

OpenRay is a Tauri 2 application built around one idea: the native platform is a slim shell,
and **almost every feature is an extension running on it**. The calculator, clipboard history,
window management and AI all use the same runtime a third-party extension does.

Two kinds of row are native rather than extension-provided: installed applications, and the
OpenRay Settings entry itself.

```
┌──────────────────────────── Rust platform (src-tauri/src) ───────────────────────────┐
│ api/          Tauri commands the webview calls: search, settings, transfer,          │
│               extensions, extension_host, registry, icons, screenshots, window       │
│ application/  palette search + frecency · CommandRegistry · extensions registry ·     │
│               extension bridge · import/export engine · hotkey dispatch · inline      │
│               queries · clipboard, file search, navigation, auto-update, auto-expand  │
│ domain/       Command and its argument types · the ports the platform depends on:     │
│               CommandProvider, AppScanner, PasteInjector, SelectionReader, Trash,     │
│               FrontmostAppReader                                                      │
│ infrastructure/ db · settings file · windows (main/settings/ext-owned) · hotkeys      │
│               (serialised behind a lock) · clipboard watcher · OCR, ffmpeg, XDND and  │
│               X11 adapters · the extension host process · extension manifest types    │
└──────────────┬────────────────────────────────────────────────┬──────────────────────┘
        JSON-RPC over stdio                              ui commits / events
               ▼                                                ▼
┌── Node sidecar (extension host) ──┐            ┌── webview (apps/desktop) ──────────┐
│ multi-command mounts + unmount    │            │ palette shell + TreeRenderer        │
│ @raycast/api compatibility shim   │            │  (List/Grid/Detail/Form/Markdown-   │
│ plus the @openray/extras surface  │            │   Editor) · settings window         │
│ every extension, built-in and     │            │ extension-owned windows host the    │
│ installed, in one process         │            │  same TreeRenderer                  │
└───────────────────────────────────┘            └────────────────────────────────────┘
```

The four directories are a convention the codebase follows, not a rule anything enforces.
There is no layering lint or test.

## Who owns what

The **Rust platform** owns windowing, hotkeys, search orchestration, the extension host
process, the bridge, import and export, settings, and the OS adapters that features reach
through the bridge: clipboard images and paste injection, window control, selected text,
confirm dialogs, and queries against platform-owned data such as clipboard history, the
screenshot index, and menu bars.

**Extensions** own all feature logic and UI description.

The **webview** renders the UI trees the extension host streams over as commits. It hosts the
palette shell plus any extension-owned secondary windows, such as Notes and AI Chat, through
the same renderer.

## One process, one build pipeline

Built-in and installed extensions are **not** separated at runtime. There is one build path
and one Node process for both, and both get the full Node runtime, including `fetch`,
`child_process` and `fs`.

The only gate applied at pack and install time is a **name-based API check**: the packer
collects what the extension imports from `@raycast/api`, `@raycast/utils`, `@openray/api`,
`@openray/utils` and `@openray/extras`, and refuses anything this build does not export. It
does not look at Node built-ins, and it cannot see an API name assembled at runtime.

So the check is a compatibility guarantee, not a security boundary. An extension runs with your
own privileges — see [Trust and security](/docs/extensions/trust-and-security).

`@openray/extras` is a **second, separate** surface rather than a superset: it never modifies a
Raycast-named export, so code written against `@raycast/api` behaves the same either way.

## The sidecar protocol

The platform talks to the Node host over stdio using JSON-RPC 2.0. Frames are **not**
newline-delimited — each payload carries a four-byte big-endian length prefix.

Two timeouts matter to anyone writing a hook. After ten seconds the host pings the process,
giving it two seconds to answer. A failed ping kills the whole host, taking every other
extension with it. A successful ping buys another two minutes, after which only that one call
fails.

## Where data lives

| Data | Where |
| --- | --- |
| Settings | `settings.json` in the config directory, not the database |
| Usage counts | The `usage` table. Frecency is computed from it, never stored |
| Aliases, hotkeys, enabled flags | The `command_settings` table |
| Clipboard history | The `clipboard_history` table, plus image files on disk |
| Screenshot index | The `screenshot_ocr`, `screenshot_thumbnails` and `screenshot_pins` tables |
| Extension data | `extension_storage`, keyed by `(extension_id, key)` |

The exact per-platform paths are in
[Core concepts](/docs/getting-started/core-concepts#where-your-data-lives).

**`extension_storage` is deliberately not exported.** An extension's data reaches an export
file only through its own hooks. Last-writer-wins merging applies to the host-owned kinds —
command settings, extension preference values, clipboard history — while usage counts are
merged by taking the larger value. See
[Import / Export hooks](/docs/developers/import-export-hooks).

## Related

- [Writing an extension](/docs/developers/writing-extensions)
- [Import / Export hooks](/docs/developers/import-export-hooks)
- [Building from source](/docs/developers/building-from-source)
