# Changelog

All notable changes to OpenRay are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/).

Each release's binaries are on the
[Releases page](https://github.com/tuanpham-dev/openray/releases).

## [Unreleased]

## [0.1.2] - 2026-09-21

### Added

- An app row shows its own description on a second line when the OS has one
  (a `.desktop` file's `Comment`, a `.lnk`'s description field) instead of
  always just "Application".
- Settings → General shows the running build's version.

## [0.1.1] - 2026-09-14

A small fix release on top of 0.1.0.

### Fixed

- Installing an extension with dependencies no longer fails with
  `spawn npm ENOENT`. OpenRay now ships npm alongside its bundled Node, so
  installs work when the app is launched from a menu or desktop entry that
  doesn't have your shell's `PATH`.
- A Detail with no metadata uses the whole page, instead of wrapping inside
  two thirds of the window next to an empty column.
- A Detail scrolls from the keyboard: the arrow keys, and Alt+J/K when
  `altJkNavigation` is on.

## [0.1.0] - 2026-09-10

The first release of OpenRay — an open-source command palette and launcher
for macOS, Windows and Linux, where almost everything, including the
features that ship with it, is an extension.

### Added

- One global hotkey (⌘ Space on macOS, Alt Space elsewhere) opens a search
  box covering applications, clipboard history, snippets, quicklinks, 35
  window-management presets, AI chat and commands, a calculator,
  translation, file and screenshot search, notes, script commands and
  system controls.
- Extensions written against `@raycast/api` build and run as-is, installable
  from a registry, a packed archive, or a local folder.

There is no Intel Mac build in this release, and the known per-platform
limitations at the time are listed on the
[Releases page](https://github.com/tuanpham-dev/openray/releases/tag/v0.1.0).

[Unreleased]: https://github.com/tuanpham-dev/openray/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/tuanpham-dev/openray/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tuanpham-dev/openray/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tuanpham-dev/openray/releases/tag/v0.1.0
