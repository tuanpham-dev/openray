---
title: First run
description: Set your hotkey, clear the Spotlight conflict, and grant the permissions paste needs.
---

## Open the palette

| Platform | Default hotkey |
| --- | --- |
| macOS | ⌘ Space |
| Windows and Linux | Alt Space |

![Root search](/openray/screenshots/root-search.svg)

Change it in [Settings → General](/docs/settings/general), or from the tray icon.

## macOS: Spotlight owns ⌘ Space too

If both are bound, **both open at once**. Spotlight holds the OS-level binding and
OpenRay's hook fires independently of it.

Unbind Spotlight under System Settings → Keyboard → Keyboard Shortcuts → Spotlight →
*Show Spotlight search*, or choose a different hotkey for OpenRay. Details in
[macOS platform notes](/docs/platforms/macos).

## macOS: grant Accessibility

The first time OpenRay pastes into another app it asks for **Accessibility** permission and
links you into System Settings → Privacy & Security → Accessibility.

Until you grant it, pasting falls back to copying to the clipboard and tells you so.
Snippet auto-expansion needs the same permission.

## Windows: if the hotkey does nothing

Windows reserves most `Win`-key combinations and some `Alt` ones for the shell, and a
combination it reserves fails to register silently. Pick one starting with `Ctrl` or `Alt`.
See [Windows platform notes](/docs/platforms/windows).

## Linux: Wayland shows a confirmation dialog

On Wayland the hotkey is bound through a desktop portal, so your compositor asks you to
confirm the binding. If you decline it, or your desktop has no portal, bind your desktop
environment's own shortcut to run `openray` — launching it a second time toggles the
palette. Recipes for GNOME, KDE and tiling compositors are in
[Linux platform notes](/docs/platforms/linux).

Wayland also cannot paste into another application, so OpenRay copies instead. That is a
platform limitation, not a setting.

## Next

- [Core concepts](/docs/getting-started/core-concepts) — how search, commands and actions fit together
- [Keyboard shortcuts](/docs/getting-started/keyboard-shortcuts)
