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

### Linux: install script

[`install.sh`](https://github.com/tuanpham-dev/openray/blob/main/install.sh) detects your
distro and architecture, downloads the matching release, and installs it through your
system's own package manager — apt/dpkg on Debian and Ubuntu, dnf/zypper/rpm on Fedora,
RHEL and openSUSE:

```sh
curl -fsSL https://raw.githubusercontent.com/tuanpham-dev/openray/main/install.sh | sh
```

Installing needs root, so it uses `sudo` and prompts for your password. Running it again
later updates the same way — installing a newer package over an existing one is an
upgrade, the same as `apt upgrade` would do. `--dry-run` prints the commands it would run
without running them, and `--version X.X.X` installs a specific version instead of the
latest. It doesn't handle macOS or Windows, or a distro with neither `dpkg` nor `rpm` — the
`.AppImage` covers those, since it runs on any Linux distro without installing anything.

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
