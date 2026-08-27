# T19b compat spike — findings

Three real extensions from [raycast/extensions](https://github.com/raycast/extensions)
(pinned at commit `62edb5f5b52d28d38c918add66553e827d9cdc4b`, 2026-08-15) were
sparse-cloned and run through the real T19 builder (`npm install` +
esbuild bundle, `@raycast/api`/`@raycast/utils` aliased to this package)
against a skeletal stub shim. Picks and rationale are in
`../extension-host/fixtures/README.md`; excerpts of their manifests/source
are checked in there for reproducibility.

- **8 Ball** (`8ball`) — no-view utility
- **Hacker News** (`hacker-news`) — view, List-based
- **Password Generator** (`password-generator`) — view, Form-based

**Result: all three bundle with zero errors**, including a real `@/`
TS path-alias import in `password-generator` that esbuild resolved
automatically via its own tsconfig auto-discovery (no extra config needed
from `builder.ts`).

## Two real bugs found and fixed in the stub (relevant beyond the spike)

1. **`.ts` under `"type": "module"` breaks CJS-style stubs.** The shim was
   first written as `index.ts` with `packages/api-shim/package.json` set to
   `"type": "module"`. Even with zero `import`/`export` keywords in the
   file, esbuild classified it as ESM (Node's own module-classification
   rule: extension + nearest `package.json` "type" field, not file
   content), and an ESM module with no static `export` bindings gets every
   named import from it **statically resolved to `undefined`** — not a
   build error, a silent wrong answer. Fixed by using the `.cts` extension
   (explicitly CommonJS regardless of package "type").

2. **A bare `new Proxy({}, {get})` silently defeats esbuild's CJS→ESM
   interop.** Even after fix #1, named imports still read as `undefined`
   *at runtime* (though the bundled reference — `import_api.Toast` — looked
   correct in the output). Cause: esbuild's `__toESM`/`__copyProps`
   interop helper copies properties onto the ESM-shaped namespace via
   `Object.getOwnPropertyNames(mod)`. A Proxy with only a `get` trap
   reports **zero** own keys (Proxy invariants fall through to the empty
   `{}` target when there's no `ownKeys` trap), so `__copyProps` copies
   nothing. Fixed by adding `ownKeys`/`getOwnPropertyDescriptor`/`has`
   traps backed by a concrete top-level key list.

   **This is the load-bearing finding for T20/T21**: the real shim's
   *top-level* module object needs concrete, statically-known named
   exports (`export const List = ...`, not a fully-dynamic catch-all
   Proxy) for ESM interop to work at all. Nested property/method access
   below the top level (`Toast.Style.Animated`, `list.push(...)`) has no
   such constraint and can be built however T20/T21 want.

Both are fixed in `src/index.cts`/`src/utils.cts` as they stand — this
isn't a residual risk, just documented so the real T20/T21 implementation
doesn't reintroduce it.

## API surface touched, with implement/stub verdict

All of the below is already inside T20/T21's planned scope — the picks
happened to be well inside the mainstream API, not edge cases. Nothing
here needs the `UnsupportedError` stub path.

| API | Where seen | Verdict | Notes |
|---|---|---|---|
| `List`, `List.Item`, `List.Dropdown`, `List.Dropdown.Item` | hacker-news | Implement (T20) | |
| `Grid`, `Detail` | — (not touched by any pick) | Implement (T20, per plan) | Unverified by this spike — real usage not exercised |
| `Form`, `Form.TextField`, `Form.Checkbox` | password-generator | Implement (T20) | |
| `ActionPanel`, `ActionPanel.Section` | hacker-news, password-generator | Implement (T20) | |
| `Action` (generic, with `onAction`/`icon`/`title`) | hacker-news | Implement (T20) | |
| `Action.OpenInBrowser`, `Action.CopyToClipboard`, `Action.SubmitForm` | hacker-news, password-generator | Implement (T20) | |
| `Icon.*` (enum-style member access, e.g. `Icon.SaveDocument`) | hacker-news | Implement (T20/T21) | Plain string/enum constants, cheap |
| `Toast` — used as a **class**: `new Toast({style,title})`, `.show()`, mutable `.style`/`.title`/`.message` | 8ball | Implement (T21) | Not just a function — needs a real constructor + instance API. T21's plan text says "showToast/Toast" generically; scope that to include the class form |
| `Toast.Style.*` (Animated/Success/Failure) | 8ball, hacker-news, password-generator | Implement (T21) | |
| `showToast` — **two call signatures observed**: `showToast({style,title,message})` (hacker-news) and `showToast(style, title, message?)` positional (password-generator) | hacker-news, password-generator | Implement (T21) | Real shim needs both overloads |
| `showHUD(message, options)` | password-generator | Implement (T21) | Called with `{clearRootSearch, popToRootType}` options object |
| `PopToRootType.Suspended` | password-generator | Implement (T21) | |
| `getPreferenceValues<T>()` | 8ball, hacker-news, password-generator | Implement (T21) | Every pick uses this; highest-value target |
| `Clipboard.copy`, `Clipboard.paste` | 8ball, password-generator | Implement (T21) | |
| `Cache` | hacker-news (via a helper file) | Implement (T21, per plan) | Only touched, not deeply exercised by this spike |
| `environment.raycastVersion` | hacker-news | Implement (T21) | Only one field observed; full `environment` shape still per plan |
| `usePromise(fn, deps, {execute})` | hacker-news (`@raycast/utils`) | Implement (T20/T21, per plan) | Exercises the `execute` gating option specifically |

## Residual gaps (not covered by this spike)

None of the three picks touch `AI`, `OAuth`, menu-bar mode (`mode: "menu-bar"`),
`Grid`, `Detail`, or `MenuBarExtra` — the plan's `UnsupportedError`-stub path
for exotic APIs is still unverified against a real extension. Per the plan's
own framing ("compat breadth is a follow-up loop: try extension → add
missing API"), the next spike iteration should specifically pick an
extension that touches one of these to validate the degrade-gracefully path,
rather than assuming it just works.

## T20 follow-up: real reconciler + components, verified against the same 3 extensions

T20 replaced the throwaway logging stub with real `List`/`Grid`/`Detail`/
`Form`/`ActionPanel`/`Action`/`useNavigation` plus a custom react-reconciler
(everything else stays stub-backed for T21). Re-running the same 3 spike
extensions through the real builder surfaced two more bugs, both fixed:

1. **`react` needs to be a real shared runtime dependency (`external`), not
   inlined per bundle.** Real extensions don't declare `react` themselves —
   confirmed absent from all 3 picks' `package.json` — it comes transitively
   from the real `@raycast/api`. Aliasing bare `react`/`react/jsx-runtime`/
   `react/jsx-dev-runtime` to api-shim's own copy fixes that supply *and*
   forces every `react`-touching import in one bundle onto the same file,
   which is required for hooks to work (React's dispatcher is a
   module-level singleton in the `react` package itself — two copies in one
   process break hooks with an "Invalid hook call" error that has nothing
   to do with the code that's actually wrong). This matters even more once
   a *separate* process mounts the compiled command through
   `react-reconciler` (T22's driver): that's a second bundle, and without
   `external` it would inline its own second copy of `react` regardless of
   the alias.

2. **`external` matches the original import specifier, not the alias
   target.** Aliasing `react` to an absolute path and separately listing
   the bare string `"react"` in `external` does *not* externalize it —
   esbuild still inlined it (confirmed by grepping the output for
   `require_react`/`require_jsx_runtime` helper functions, which show up
   only when something got bundled rather than left as a real `require()`
   call). Nothing errors or warns about this — it fails exactly as silently
   as the two T19b bugs. Fix: list the *resolved absolute paths themselves*
   (the same values used as the alias targets) in `external`, not the bare
   specifiers.

**Full verification**: mounted `password-generator`'s actual compiled
`generate-random-password.js` (unmodified, built by the real T19 builder)
through the real reconciler and got exactly the expected tree —
`__root > Form > (Form.TextField, Form.Checkbox ×2, __actions > ActionPanel > Action)`
— proving the whole chain end to end: real extension source → esbuild
bundle with the shim aliased in → mount() → correct UI-tree snapshot.
`hacker-news` gets past its own module load and into an actual render
attempt, then hits `environment.raycastVersion` used in a template literal
at module top level — an expected T21-scope gap (a stub value can't satisfy
`ToPrimitive` coercion), not a T20 bug.

## T21 follow-up: imperative APIs implemented for real

Every row in the coverage table above marked "Implement (T21)" is now real,
via an injectable `HostBridge` (`src/bridge.ts`) so each one is testable
against a mock RPC transport without a running sidecar or Rust process:
`Clipboard`, `Toast`/`showToast` (both call signatures), `LocalStorage`
(namespaced by extension id), `Cache` (file-backed, sync, no RPC — see
below), `getPreferenceValues`/`environment` (synchronous, from a
command-context set once per command run — this specifically fixes the
`environment.raycastVersion` ToPrimitive crash found mounting `hacker-news`
in T20), `open`/`closeMainWindow`/`popToRoot`/`showHUD`/`showInFinder`/
`trash`/`getSelectedText`/`getSelectedFinderItems`/`getApplications`/
`getFrontmostApplication`/`getDefaultApplication`/`confirmAlert`/
`updateCommandMetadata`, `Icon`/`Color` (plain constants, no RPC), and
`usePromise`/`useCachedState` from `@raycast/utils` (pure React state —
`Cache`-backed for `useCachedState`, no RPC either).

**What "real" means here, precisely**: the Node-side shim API surface is
real and fully tested. The *Rust-side* RPC method handlers
(`host.clipboard.copy`, `host.storage.get`, etc.) are not implemented yet —
`getHostBridge().call(...)` will reach Rust and get a "method not found"
error from the existing generic dispatch until something registers real
handlers for these method names. That's deliberately out of T21's scope
(its file list is `packages/api-shim/src/api/*` only) and lands wherever
actually running an extension command end-to-end does (T22 or a focused
follow-up) — same shape as T19's esbuild-bundle-succeeds-but-doesn't-run
scoping decision.

**Still stub-backed** (not touched by any of the 3 spike extensions, no
COMPAT.md verdict requiring them yet): `MenuBarExtra`, `Keyboard`. `AI`/
`OAuth` are intentionally stub-*shaped* rather than unimplemented — they
throw a typed `UnsupportedError` (plus a best-effort toast) on first real
use, per the plan's degrade-instead-of-crash requirement, which is the
correct terminal state for these, not a placeholder waiting on more work.
