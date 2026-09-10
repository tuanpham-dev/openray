---
title: macOS
description: Opening an unsigned build, the hotkey conflict with Spotlight, and the Accessibility permission.
---

## macOS says the app is damaged, or refuses to open it

OpenRay's macOS builds are **not code-signed or notarised**, because that needs a paid Apple
Developer account. Gatekeeper therefore quarantines the download, and depending on your macOS
version it will either refuse to open it or claim the app "is damaged and can't be opened".

Nothing is damaged. Strip the quarantine attribute and it opens normally:

```sh
xattr -cr /Applications/openray.app
```

Run that once, after moving the app to Applications. If you put it somewhere else, point the
command at that path instead.

You can also right-click the app and choose **Open** the first time, which offers an override
in the dialog, though on recent macOS versions the `xattr` command is the reliable route.

Only do this for software you actually trust. It is the same step every unsigned open-source
Mac app requires, and it is worth understanding rather than pasting blindly: it removes the
`com.apple.quarantine` flag that Safari or your browser attached to the download.

## The palette does not steal focus

On macOS the palette is an `NSPanel` rather than an ordinary window. Showing it leaves the
app you were in frontmost in the menu bar, which is what lets OpenRay paste back into that
app rather than into itself.

OpenRay also runs without a Dock icon (`ActivationPolicy::Accessory`). Use the tray icon
or the hotkey to bring it up.

## Cmd+Space conflicts with Spotlight

The default hotkey on macOS is **⌘ Space**, which Spotlight also owns by default. If both
are bound, **both open at once**: Spotlight holds the OS-level binding, and OpenRay's
global-shortcut hook fires independently of it.

Unbind Spotlight first, under System Settings → Keyboard → Keyboard Shortcuts →
Spotlight → *Show Spotlight search*. This is the same prerequisite Raycast documents for
itself. Alternatively, pick a different hotkey in
[Settings → General](/docs/settings/general).

## Accessibility permission

Pasting into another app, and snippet auto-expansion, both need **Accessibility**
permission. OpenRay asks for it before its first keystroke injection, and macOS shows the
system dialog with a link into System Settings → Privacy & Security → Accessibility.

Until you grant it, a paste falls back to **copying to the clipboard only** and says so
rather than silently doing nothing. Input Monitoring may also be prompted for the snippet
keystroke listener.

## What is verified on real hardware

Confirmed on a real Mac: the non-activating panel, the default hotkey and the Spotlight
conflict above, and snippet auto-expansion expanding a keyword in place with the clipboard
preserved.

Still unverified on real hardware: app launch through `open -a`, paste injection landing in
the right app, the Accessibility dialog itself, the hidden Dock icon, and the native
Import / Export file dialogs. The full breakdown is in
[Platform verification](/docs/developers/platform-verification).
