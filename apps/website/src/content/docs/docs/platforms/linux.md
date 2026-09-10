---
title: Linux
description: X11 works as expected; Wayland limits global hotkeys and paste injection.
---

The default hotkey on Linux is **Alt+Space**. Which of the features below work depends on
whether your session is X11 or Wayland.

```sh
echo $XDG_SESSION_TYPE   # x11 or wayland
```

## X11

Everything behaves as on the other platforms: the global hotkey is registered directly,
paste injection synthesises a real keystroke into the focused app, and snippet
auto-expansion listens through the X server's XRecord extension.

If your X server has no XRecord extension, auto-expansion fails gracefully and the
Snippets settings pane shows a banner instead. Expanding a snippet from the palette still
works.

## Wayland

Wayland deliberately forbids a client from observing or synthesising keystrokes in another
application. That has three consequences.

**Paste becomes copy.** OpenRay copies to the clipboard and reports that honestly rather
than pretending to paste. You press paste yourself in the target app.

**Snippet auto-expansion is unavailable.** Turning the toggle on shows a banner saying so.
Expanding a snippet from the palette still works, subject to the clipboard fallback above.

**The global hotkey goes through a portal.** OpenRay binds it through
`org.freedesktop.portal.GlobalShortcuts`, which makes your compositor show its own
confirmation dialog. This is the only way to get a global hotkey on Wayland at all.

## No portal, or the bind dialog was declined?

Bind your desktop environment's own keyboard-shortcut setting to launch (or re-launch) the
`openray` binary. A second launch just toggles the existing palette instead of opening a
duplicate window.

- **GNOME**: Settings → Keyboard → Keyboard Shortcuts → View and Customize Shortcuts →
  Custom Shortcuts → **+**. Set the command to `openray` (or the full path to the AppImage
  or installed binary), then assign your key combination.
- **KDE Plasma**: System Settings → Shortcuts → Custom Shortcuts → Edit → New → Global
  Shortcut → Command/URL. Set the command to `openray` and bind a combination under the
  Trigger tab.
- **sway, Hyprland, or any compositor with its own keybinding config**: bind an
  `exec`-style directive to run `openray`.

When the portal is unavailable, OpenRay's Settings window shows a banner pointing at this
same fallback.

## What is verified

App scanning, the global hotkey path, paste injection logic, and the whole Import / Export
data path are covered by tests that run natively on Linux in CI. The Wayland portal
round-trip and the XRecord keystroke tap have not been exercised against a real compositor
or X server in this project's sandbox. See
[Platform verification](/docs/developers/platform-verification).
