# T19b compat-spike fixtures

Lightweight excerpts (manifest + the one command source file actually
analyzed) from three real, MIT-licensed extensions in
[raycast/extensions](https://github.com/raycast/extensions), pinned to commit
`62edb5f5b52d28d38c918add66553e827d9cdc4b` (2026-08-15). Not full checkouts —
`node_modules` and unrelated command files are excluded to keep this small;
re-fetch the full extension with the sparse-clone approach in
`src/builder.ts`'s `installStoreSlug` if you need the rest of a given
extension's source.

| Extension | Slug | Mode picked | Why |
|---|---|---|---|
| 8 Ball | `8ball` | no-view | Simplest possible command: no rendering, just `Clipboard`/`Toast`/`getPreferenceValues`. Only case where dynamically *executing* the bundle (not just bundling it) is safe pre-T20, since it's a plain async function, not a React component needing a reconciler. |
| Hacker News | `hacker-news` | view (List) | Real List usage: sections via `List.Dropdown`, `List.Item`, `ActionPanel.Section`, mixed generic `Action` + specific `Action.OpenInBrowser`/`Action.CopyToClipboard`, and `usePromise` from `@raycast/utils`. Imports `@raycast/api` from three separate source files, not just the command entry — good stress test for whether the alias applies uniformly across a bundle graph. |
| Password Generator | `password-generator` | view (Form) | `Form`/`Form.TextField`/`Form.Checkbox`/`Action.SubmitForm`, `showHUD` with an options object, and a `showToast(style, title, message)` *positional* call (a second `showToast` calling convention the object-style call in `hacker-news` doesn't exercise). Also uses a `@/`-prefixed TS path-alias import, a real-world build wrinkle worth surfacing.

See `../../api-shim/COMPAT.md` for the full findings and API-coverage list.
