---
title: FAQ
description: The things that go wrong first, and what to do about them.
---

## macOS says OpenRay is damaged and can't be opened

The Mac builds are unsigned, so Gatekeeper quarantines them. The app is fine. Clear the
quarantine flag once:

```sh
xattr -cr /Applications/openray.app
```

Full explanation in the [macOS notes](/docs/platforms/macos).

## The hotkey does nothing

**On Windows**, the shell reserves most `Win` combinations and some `Alt` ones, and a reserved
combination fails to register silently. Pick one starting with `Ctrl` or `Alt`.

**On Wayland**, the hotkey is bound through a desktop portal that your compositor may override
or refuse. If the confirmation dialog never appeared, or you declined it, bind your desktop's
own shortcut to run `openray` instead — launching it twice toggles the palette. Recipes for
GNOME, KDE and tiling compositors are in [Linux notes](/docs/platforms/linux).

Otherwise, check the combination is not already taken by another command in
[Settings](/docs/settings/extensions-and-commands).

## Spotlight opens at the same time as OpenRay

Both are bound to ⌘ Space and both fire. Unbind Spotlight under System Settings → Keyboard →
Keyboard Shortcuts → Spotlight, or give OpenRay a different hotkey. See
[macOS notes](/docs/platforms/macos).

## Paste only copies, it does not paste

**On Wayland**, no application may type into another one. OpenRay copies to the clipboard and
says so rather than pretending. Press paste yourself.

**On macOS**, grant Accessibility permission. Until you do, every paste falls back to copying.
System Settings → Privacy & Security → Accessibility.

## Snippet auto-expansion is not firing

Check, in order:

- It is off by default. Turn on **Auto-Expand Snippets** in Settings → Snippets.
- The snippet needs a **keyword**. One without a keyword never expands.
- Snippets that take an `{argument}` are never auto-expanded. Their keyword still works from
  the palette.
- On Wayland it is not possible at all. On macOS it needs Accessibility permission.

The Snippets settings pane shows a banner when it cannot start, explaining which of these it is.

## Search Files or Search Screenshots is missing

Both stay hidden until you configure a folder. Settings → File Search → Search Scopes, or
Settings → Screenshots → Search Scopes.

File Search also needs its first background index to finish before results appear.

## Menu Bar Search comes up empty

The command appears wherever menu reading is possible in principle, but two platforms often
have nothing to give it.

**On Windows** it reads the classic Win32 menu bar. Electron apps, Store apps and Office draw
their own menus and expose nothing, so those come up empty.

**On Linux** it reads menus over D-Bus from a KDE/Qt or GTK global-menu exporter. A desktop
with no such exporter — a stock XFCE session, for instance — publishes nothing to read.

See [Menu Bar Search](/docs/features/menu-bar-search).

## Search Files cannot find a file I know is there

The index skips hidden files, and it honours `.gitignore`, `.ignore` and your global git
excludes. A file you gitignored, or anything starting with a dot, will not appear. See
[File Search](/docs/features/file-search).

## Window commands do not move anything

Window control is X11-only on Linux and unavailable on Wayland, where the commands are hidden
entirely. On macOS it needs Accessibility permission, prompted on first use.

## An extension failed to install

Installing checks that the archive only uses APIs this version of OpenRay provides, and — when
the catalogue declares a checksum — that the file matches it. A failure leaves your previous
version in place.

If the extension is already installed from a different registry, OpenRay asks before replacing
it. Built-in extensions and extensions you are developing locally cannot be replaced at all —
stop developing it first.

## Where is my data?

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Settings | `~/Library/Application Support/openray` | `~/.config/openray` | `%APPDATA%\openray` |
| Database | `~/Library/Application Support/com.openray.desktop` | `~/.local/share/com.openray.desktop` | `%APPDATA%\com.openray.desktop` |

To move it to another machine, use [Import / Export](/docs/settings/import-export) rather than
copying files.

## Does OpenRay send my data anywhere?

There is no account, and no analytics or telemetry of any kind. OpenRay makes network requests
in four places, all of them visible to you:

| What | Where it goes | When |
| --- | --- | --- |
| [AI](/docs/features/ai) | Directly to the provider whose key you entered, with no proxy | When you send a message or run an AI Command |
| [Translate](/docs/features/translate) | Google's free translation endpoint | When you translate something |
| [Calculator](/docs/features/calculator) | A public exchange-rate service | To refresh currency rates when they are over twelve hours old |
| [The Store](/docs/extensions/store) | The registries you have added | To load catalogues, and to check for updates once a day |

Extensions you install can make their own network calls. That is one reason adding a registry
is the trust decision — see [Trust and security](/docs/extensions/trust-and-security).

## Can I use Raycast extensions?

Extensions written against `@raycast/api` build and run here, and can be pointed at directly
from the raycast/extensions monorepo. Compatibility is not total: Raycast's own `AI` API and its
`OAuth.PKCEClient` are not implemented, and an extension using an unimplemented API is rejected
at install rather than failing halfway through at runtime. See
[Installing extensions](/docs/extensions/installing).
