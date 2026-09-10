---
title: Install
description: Download OpenRay for macOS, Windows or Linux, and what happens on first launch.
---

OpenRay ships installers for all three desktop platforms from the
[GitHub Releases page](https://github.com/tuanpham-dev/openray/releases/latest).

| Platform | Download | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | `.dmg` | Drag to Applications |
| Windows (x64) | `.msi` or `.exe` | Either installer works |
| Linux (x64 and arm64) | `.deb`, `.rpm`, `.AppImage` | The `.rpm` is the Fedora-installable package |

Builds are produced by CI on a tagged release for `aarch64-apple-darwin`,
`x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu`.

Prefer to build it yourself? See [Building from source](/docs/developers/building-from-source).

On **macOS** the build is unsigned, so the first launch needs one extra step — see
[macOS says the app is damaged](/docs/platforms/macos#macos-says-the-app-is-damaged-or-refuses-to-open-it).

## First launch

OpenRay starts in the background and puts a **monochrome bolt in your tray or menu bar**.
There is no Dock icon on macOS — the launcher is the interface, and the tray icon is there
to bring it up or open Settings.

Press the global hotkey to open the palette:

| Platform | Default hotkey |
| --- | --- |
| macOS | ⌘ Space |
| Windows and Linux | Alt Space |

On macOS, ⌘ Space is also Spotlight's default and the two will both open until you unbind
Spotlight. That, and the permission prompts you may see, are covered in
[First run](/docs/getting-started/first-run).

## Uninstalling

Remove the application the way your platform normally does. Your data lives outside the
application bundle, so reinstalling later picks up where you left off. Export first if you
want to move it to another machine — see [Import / Export](/docs/settings/import-export).
