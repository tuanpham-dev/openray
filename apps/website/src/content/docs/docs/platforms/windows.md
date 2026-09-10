---
title: Windows
description: Hotkey combinations the shell reserves, and what is still unverified.
---

## The default hotkey is Alt+Space

Windows reserves a large part of the keyboard for the shell. `Win`-key combinations are
almost entirely off limits, and some `Alt` combinations are too. The default **Alt+Space**
avoids the worst of these.

A hotkey you choose yourself **can silently fail to register** — there is no in-app
conflict detection yet. If rebinding a hotkey appears to do nothing, try a combination
starting with `Ctrl` or `Alt` instead of `Win`.

## Showing the window takes focus

Windows' foreground-lock heuristic normally ignores a request to raise a window that did
not come from a key press, which would leave the palette visible but unfocused when opened
from the tray icon or by launching OpenRay a second time. OpenRay performs the standard
`AttachThreadInput` handshake before raising itself so those paths take focus too.

## The tray icon follows the taskbar

The tray glyph is monochrome and picks black or white from the **taskbar's** own theme
rather than the apps theme, because Windows tracks the two separately and light apps over
a dark taskbar is a common default.

## No permission prompt

Unlike macOS, Windows needs no accessibility grant for paste injection or for the snippet
keyboard hook.

## What is verified

Everything on Windows is compile-checked in CI against the real target, and nothing on it
has been exercised on real hardware yet: shortcut resolution, focus stealing, paste
injection, snippet auto-expansion, and the native file dialogs are all listed as
known gaps in [Platform verification](/docs/developers/platform-verification).
