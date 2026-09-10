---
title: Import / Export hooks
description: Let your extension's data ride along with the user's export file.
---

An extension opts into Settings → Import / Export by declaring an `export` block in its
manifest and shipping the two hooks it names.

```jsonc
// package.json
"export": {
  "title": "Quicklinks",                  // the checkbox label
  "description": "Your saved quicklinks", // optional, shown beside it
  "entry": "export"                       // optional, defaults to "export"
}
```

```ts
// src/export.ts
export const exportVersion = 1                      // optional, yours to define
export async function exportData(): Promise<unknown>
export async function importData(data: unknown, version: unknown): Promise<void>
```

`exportVersion` may also be a function, including an async one. Omit it and the version
recorded is `null`.

The declaration is read from the manifest at registration, so the pane can list the
extension without starting it. The hooks are only called when the user actually exports
or imports. Whatever `exportData` returns is stored verbatim under the extension's id
and handed back to `importData` unchanged — the host never interprets it, so the payload
shape and its versioning are entirely your own.

## Three rules worth knowing

**Keep both hooks async, and yield.** Every extension shares one Node process. After ten
seconds the host pings that process and gives it two seconds to answer. Synchronous CPU work
blocks the ping, and a failed ping kills the whole host — taking every other extension down
with it. Answer the ping and you get another two minutes, after which only your call fails.

**Never return secrets.** Nothing filters `exportData`'s return value, so keep API keys and
tokens out of your payload. Store them under a `secret:`-prefixed storage key.

Be aware of the one secret that *does* travel: a preference you declare with type `password`
is included in an export. The user is warned and offered the chance to exclude them, but the
safe place for a credential is a `secret:` storage key, not a password preference.

**Import should add and update, not wipe.** Restore under the original keys so re-importing
the same file overwrites rather than duplicating, and leave entries the file doesn't mention
alone. Nothing enforces this — the host hands your data straight to `importData` and does not
constrain what you write, so it is a contract you keep, not one you are given.

An extension's own data reaches the file *only* through these hooks. The host does not export
`extension_storage` at all, so an extension without them contributes nothing to an export.

## Related

- [Import / Export (user guide)](/docs/settings/import-export)
- [Writing an extension](/docs/developers/writing-extensions)
