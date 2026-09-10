---
title: Switch Windows
description: Search every open window by title or application and jump straight to it.
---

![Switch Windows](/openray/screenshots/switch-windows.svg)

**Switch Windows** lists every open window across every application. Each row shows the
window's own title with its application underneath, so two browser windows are told apart by
what is in them.

## Actions

| Action | Shortcut |
| --- | --- |
| Switch to Window | ↵ |
| Close Window | ⌘⌫ |

Close sends a polite close request, the same as clicking the window's close button. It does
not kill the process.

## Platform support

| Platform | Works | Requires |
| --- | --- | --- |
| Linux (X11) | yes | nothing |
| Linux (Wayland) | **no** | Wayland has no way for an app to list other windows |
| macOS | yes | Accessibility permission |
| Windows | yes | nothing extra |

Where it is unavailable, the command still appears but shows **Window Switching
Unavailable** rather than an empty list.

On Linux, window icons come from the window itself when the app does not match an installed
application.

## Related

- [Window Management](/docs/features/window-management)
- [Applications](/docs/features/applications)
