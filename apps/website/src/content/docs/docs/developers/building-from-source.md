---
title: Building from source
description: Run OpenRay's development build, and regenerate the app and tray icons.
---

## Prerequisites

Node 20 or newer, [pnpm](https://pnpm.io), and a Rust toolchain. On Linux you also need
Tauri's system dependencies:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libgtk-3-dev patchelf build-essential
```

## Run it

```sh
pnpm install
pnpm fetch:node-sidecar   # fetches the Node runtime the extension host sidecar needs
pnpm dev                  # tauri dev
```

`fetch:node-sidecar` asks `rustc` for your host target, so the Rust toolchain has to be on your
PATH before you run it. Pass a target triple explicitly to fetch a different one:

```sh
node scripts/fetch-node-sidecar.mjs aarch64-apple-darwin
```

`pnpm dev` does more than start Tauri. Before the window opens it builds the extension host,
stages it into the app bundle, and builds every first-party extension, because the app reads
that output off disk to register them. A clean checkout that skips this has no built-in
commands.

`pnpm build` runs a full `tauri build`. On a tagged push, CI builds four targets — Linux x64 and
arm64, macOS on Apple Silicon, and Windows x64 — and opens a **draft** GitHub release with the
installers attached. A manual workflow run builds the same targets and uploads them as workflow
artifacts instead.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test                 # every workspace package's own suite

# Build the host and the built-in extensions first, or the Rust tests that
# exercise the real sidecar silently skip themselves instead of failing.
pnpm --filter @openray/extension-host build
node scripts/build-builtin-extensions.mjs

cd src-tauri
cargo test --lib --features custom-protocol
cargo clippy --all-targets -- -D warnings
```

CI runs all of the above. It also runs `cargo check` and `cargo clippy` for
`aarch64-apple-darwin` and `x86_64-pc-windows-msvc` on every push and pull request, which is how
platform-specific code stays compiling without those machines. See
[Platform verification](/docs/developers/platform-verification).

## Regenerating the app icon

The app icon's source of truth is `src-tauri/icons/icon.svg` — the same bolt the webview
ships as its favicon, on a filled tile. After editing it, rasterize and regenerate the
whole PNG/ICO/ICNS set:

```sh
magick -background none src-tauri/icons/icon.svg -resize 1024x1024 /tmp/openray-icon.png
pnpm tauri icon /tmp/openray-icon.png
rm -rf src-tauri/icons/android src-tauri/icons/ios src-tauri/icons/64x64.png
```

The last line drops output for the mobile targets and a size this project doesn't bundle
— see `tauri.conf.json`'s `bundle.icon`.

## Regenerating the tray icon

The tray icon is separate, and monochrome on every platform: the bare bolt, in solid black
(`src-tauri/icons/tray.svg`) and solid white (`tray-inverted.svg`).

macOS is handed the black one as a *template* image and recolours it itself for a light or
dark menu bar. Linux and Windows draw the bitmap as given, so `tray::apply_system_theme`
picks between the two by the panel's theme and re-picks when it changes. On Linux that is
the desktop theme; on Windows it is the taskbar's own `SystemUsesLightTheme` setting, read
from the registry — the theme Tauri reports there is the *apps* one
(`AppsUseLightTheme`), and the two commonly differ.

```sh
magick -background none src-tauri/icons/tray.svg -resize 72x72 PNG32:src-tauri/icons/tray@2x.png
magick -background none src-tauri/icons/tray-inverted.svg -resize 72x72 PNG32:src-tauri/icons/tray-inverted@2x.png
```

## Documentation site

This site lives in `apps/website` and deploys from `.github/workflows/pages.yml`, which runs on
pushes that touch `apps/website` or the workflow itself.

```sh
pnpm --filter openray-website dev         # local preview
pnpm --filter openray-website screenshots # regenerate the SVG screenshots
pnpm --filter openray-website build
```

The screenshots are drawings, not captures: `apps/website/scripts/render-screenshots.mjs`
renders declarative scenes to SVG using the app's own dark palette. Edit a scene there and
re-run the script rather than editing an SVG by hand.

## Related

- [Architecture](/docs/developers/architecture)
- [Platform verification](/docs/developers/platform-verification)
