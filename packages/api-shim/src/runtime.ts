/**
 * The sidecar runner's entry point into this package — NOT part of the
 * `@raycast/api`-facing surface (`index.cts`/`utils.cts`), which is only
 * ever imported by extension code via the esbuild alias. This is imported
 * directly by `packages/extension-host` (a real workspace dependency, not
 * an alias) to actually mount a command and route callbacks/host calls.
 */
export { mount, invokeCallback, type MountHandle } from './reconciler'
export { setHostBridge, type HostBridge } from './bridge'
export { setCommandContext, getCommandContext, runInCommandContext, type CommandContext, type PlatformInfo, type Capabilities } from './api/command-context'
export { setCacheRootDirectory } from './api/cache'
// T24: lets `packages/extension-host`'s runner install the real `Window`
// shim implementation — see `window-mounter.ts`'s doc comment for why this
// needs its own slot rather than reusing HostBridge.
export { setWindowMounter, type WindowMounter, type ExtensionWindowOptions, type ExtensionWindowHandle } from './window-mounter'
