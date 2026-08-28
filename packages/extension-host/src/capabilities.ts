import * as compatApi from '@openray/api-shim'
import * as compatUtils from '@openray/api-shim/utils'
import * as extras from '@openray/api-shim/openray'

/*
 * Compatibility is answered by asking the shim what it actually exports,
 * not by comparing version numbers.
 *
 * A semver gate can only say "this was built against something newer" — it
 * can't say what would break, and it's wrong in both directions (a newer
 * build that touches nothing new is refused; an older one that uses a
 * removed API is admitted). The shim's own export list is the real
 * contract, and it's available for free at runtime because the host bundle
 * already imports it.
 *
 * The names an extension uses come from {@link collectUsedApis} at pack
 * time, so this check runs identically in a registry's CI and on the
 * installing machine — the packer finds out first, the user is protected
 * anyway.
 */

/**
 * The shim's entry points are CommonJS (`module.exports = {...}` in
 * `index.cts`), and a CJS module reached through an ESM `import *` arrives
 * in one of two shapes depending on who did the interop: named keys
 * directly (esbuild, which is how the host bundle is built), or everything
 * behind `default` (the general interop rule, which is what a plain
 * transform produces). Unwrapping a default-only namespace covers both,
 * rather than the check silently reporting an empty surface — and an empty
 * surface would fail *every* extension, which is precisely the failure
 * mode worth being defensive about.
 */
function exportedNames(module: object): string[] {
  const keys = Object.keys(module).filter((key) => key !== '__esModule')
  if (keys.length === 1 && keys[0] === 'default') {
    const inner = (module as { default?: unknown }).default
    if (inner && typeof inner === 'object') return exportedNames(inner)
  }
  return keys
}

function shimExportNames(): Set<string> {
  const names = new Set<string>()
  for (const module of [compatApi, compatUtils, extras]) {
    for (const name of exportedNames(module)) names.add(name)
  }
  // Interop artifacts, never something an extension imports by name.
  names.delete('default')
  names.delete('__esModule')
  return names
}

let cached: Set<string> | null = null

/** Every top-level name the compat surface + extras provide. */
export function providedApis(): Set<string> {
  if (!cached) cached = shimExportNames()
  return cached
}

/**
 * The subset of `used` this build can't satisfy — empty means installable.
 *
 * `'*'` (a namespace import, `import * as api from '@raycast/api'`) is
 * ignored rather than treated as "needs everything": the extension may
 * touch two properties of it, and refusing every namespace-importing
 * extension would be a false negative far more often than a true one.
 * Same posture as the check's other documented limit — it verifies
 * top-level names, not member access.
 */
export function missingApis(used: readonly string[]): string[] {
  const provided = providedApis()
  return used.filter((name) => name !== '*' && !provided.has(name)).sort()
}
