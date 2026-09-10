---
title: Installing extensions
description: From a registry, a .orx archive, a local folder, or the raycast/extensions monorepo.
---

There are four ways to get an extension into OpenRay.

## From a registry

Use the [Store](/docs/extensions/store) command. This is the normal path, and the only one
that also gives you updates.

## From a `.orx` archive

Settings → **Add Extension** → choose an extension archive. Useful for something a
colleague packed, or a build you produced yourself with `openray pack`.

## From a local folder

Settings → **Add Extension** → **Choose Folder…** points OpenRay at a folder you are
working on. It builds the folder where it sits and watches it, so every save rebuilds and
hot-reloads whatever is on screen. Your checkout stays the only copy.

From a terminal, `npx openray develop` does the same thing. See
[Writing an extension](/docs/developers/writing-extensions).

## From the raycast/extensions monorepo

OpenRay's API is `@raycast/api`-compatible, so extensions from
[raycast/extensions](https://github.com/raycast/extensions) can be pointed at directly and
built the same way a local folder is.

An extension that reaches for an API OpenRay does not implement is rejected at pack or install
time rather than failing halfway through at runtime. The notable gaps are Raycast's own `AI` API
and `OAuth.PKCEClient`. Menu Bar Extra **is** implemented, and renders a real tray icon.

## Managing what is installed

Every installed extension gets its own entry in the Settings sidebar, where you can
disable it, disable individual commands, give a command an alias or a hotkey, and set the
extension's own preferences. See
[Extensions and commands](/docs/settings/extensions-and-commands).

## Related

- [Trust and security](/docs/extensions/trust-and-security)
- [The Store](/docs/extensions/store)
