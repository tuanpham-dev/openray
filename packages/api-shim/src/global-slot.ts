/**
 * Backs a module-level "singleton" with a `globalThis` property instead of
 * a plain closure variable.
 *
 * Why this matters here specifically: the sidecar's own bundle (host.cjs)
 * and each extension's compiled command are two *separate* esbuild builds.
 * Both inline this package's source (via the `@raycast/api` alias for
 * extensions, directly for host.cjs), so a plain `let current = ...`
 * module-level variable becomes two distinct variables at runtime — one
 * per bundle. Setting it from the host side (runner.ts, configuring the
 * bridge/context before a command runs) never becomes visible to the
 * extension's own copy reading it. Confirmed empirically for three
 * separate singletons this package needs to share across that boundary:
 * the navigation stack (hooks.ts), the HostBridge (bridge.ts), and the
 * Cache root directory (api/cache.ts). `globalThis` has no such per-bundle
 * identity — there's exactly one Node process, so exactly one `globalThis`.
 */
export function globalSlot<T>(key: string): { get(): T | undefined; set(value: T): void; clear(): void } {
  const globalKey = `__openray_${key}`
  return {
    get(): T | undefined {
      return (globalThis as Record<string, unknown>)[globalKey] as T | undefined
    },
    set(value: T): void {
      ;(globalThis as Record<string, unknown>)[globalKey] = value
    },
    clear(): void {
      delete (globalThis as Record<string, unknown>)[globalKey]
    },
  }
}
