---
title: Trust and security
description: What adding a registry actually commits you to, and what is and is not verified.
---

## Adding a registry is the trust decision

An extension runs inside OpenRay's extension host **with your own privileges**. It is
ordinary Node code. There is no sandbox that would let you safely install something you do
not trust.

With automatic updates enabled — which is the per-source default — new versions install
**without asking**. So the moment you trust is when you add the registry, not when a
particular extension arrives from it.

Add registries you trust.

## Archives are unsigned, and the checksum is optional

A catalogue entry **may** declare a `sha256`. When it does, OpenRay verifies it on download and
refuses a mismatch, which pins the file you receive to the file the catalogue describes.

When it does not — and a hand-written catalogue can simply omit the field — the archive is
installed with **no verification at all**. Archives produced by the official tooling always
carry one, but nothing requires a registry to use that tooling.

Either way, a checksum says nothing about **who published it**. There is no signature and no
publisher identity to check. A registry you trust is a registry whose operator you trust.

## What packing does check

Packing an extension into a `.orx` archive refuses anything that:

- does not build cleanly,
- uses an API this OpenRay does not provide — recorded in the archive and re-checked at
  install time,
- ships a native binary or an install script,
- inlines third-party code without carrying a LICENSE.

These are integrity and portability checks. They are not a security review of what the
extension's own code does.

The API check in particular is about **compatibility, not safety**. It reads the names an
extension imports from OpenRay's own API packages and refuses ones this build does not provide.
It does not look at Node built-ins, so an extension importing `child_process` or `fs` passes it
untouched — as it must, since first-party extensions rely on exactly that.

## Secrets

Extension secrets belong under a `secret:`-prefixed storage key. OpenRay's export refuses
to write those to an export file, so API keys and tokens do not travel in a backup. See
[Import / Export](/docs/settings/import-export).

## Removing the default registry

Every install starts with one registry already added:
[OpenRay Extensions](https://tuanpham-dev.github.io/openray-extensions/), seeded on first
run. It has no privileges the others lack. Remove it in Settings and it stays removed.

## Related

- [Installing extensions](/docs/extensions/installing)
- [Packaging and registries](/docs/developers/packaging-and-registries)
