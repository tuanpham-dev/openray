// The real @raycast/api shim entry point. Still .cts, not .ts — see the
// comment block below for why that still matters even though this file no
// longer needs the fully-dynamic Proxy trick from the T19b spike for
// *implemented* exports.
//
// Design: real, statically-known bindings (T20's components, T21's
// imperative APIs) are plain `export`s — COMPAT.md's load-bearing finding
// is that esbuild's CJS->ESM interop needs concrete top-level keys, and
// real exports satisfy that automatically, no ownKeys/getOwnPropertyDescriptor
// juggling required for them specifically.
//
// Everything NOT yet implemented (Icon, Color, Keyboard, MenuBarExtra, ...)
// still falls back to the T19b-style logging stub Proxy, spread into a
// plain object at module-load time so the *final* exported value is a real,
// concrete object either way — never a live Proxy escaping this module.
// `{...stubFallback, ...realExports}` (real bindings last) means an import
// of an unimplemented name still resolves to a stub instead of `undefined`,
// and importing something a later task adds just starts finding a real
// value with no changes needed here.

import { List } from './components/List'
import { Grid } from './components/Grid'
import { Detail } from './components/Detail'
import { Form } from './components/Form'
import { ActionPanel, Action } from './components/ActionPanel'
import { useNavigation } from './hooks'
import { Clipboard } from './api/clipboard'
import { showToast, Toast } from './api/toast'
import { LocalStorage } from './api/storage'
import { Cache } from './api/cache'
import { getPreferenceValues } from './api/preferences'
import { environment, LaunchType } from './api/environment'
import {
  open,
  closeMainWindow,
  popToRoot,
  showHUD,
  showInFinder,
  trash,
  getSelectedText,
  getSelectedFinderItems,
  getApplications,
  getFrontmostApplication,
  getDefaultApplication,
  confirmAlert,
  updateCommandMetadata,
  Alert,
  PopToRootType,
} from './api/system'
import { AI, OAuth, UnsupportedError } from './api/unsupported'
import { Icon, Color, Image } from './api/icon'

const KNOWN_EXPORTS = ['MenuBarExtra', 'Keyboard']

/**
 * Stub diagnostics go to stderr, where the extension host picks them up as
 * log lines — that is how an extension touching an unimplemented API
 * becomes visible instead of silently getting `undefined`.
 *
 * `OPENRAY_SHIM_QUIET` exists for tooling that loads this module to
 * *inspect* it rather than run an extension against it (`openray pack`
 * reads the export list for its capability check, and would otherwise
 * print a screenful of import warnings for APIs nobody called).
 */
function shimLog(message: string): void {
  if (process.env.OPENRAY_SHIM_QUIET) return
  process.stderr.write(`[api-shim] ${message}\n`)
}

function makeApiStub(path: string): unknown {
  const target = function openrayApiStub() {}
  return new Proxy(target, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then' || prop === 'toJSON' || prop === '$$typeof') return undefined
      // A stub is routinely handed straight to React as a prop
      // (`shortcut={Keyboard.Shortcut.Common.Open}`), and React's own dev
      // logging stringifies props. Returning a nested stub for `toString`
      // and `valueOf` makes the object impossible to coerce — JS throws
      // "Cannot convert object to primitive value", and because that lands
      // *during the commit phase* it leaves the reconciler mid-work, so
      // every later update dies with "Should not already be working". One
      // unimplemented API used as a prop took the whole command down.
      // Found with the real `wikipedia` extension.
      // (`Symbol.toPrimitive` is already handled by the symbol check above,
      // which returns undefined and so falls back to these two.)
      if (prop === 'toString' || prop === 'valueOf') {
        return () => `[openray stub: ${path}]`
      }
      shimLog(`access ${path}.${String(prop)}`)
      return makeApiStub(`${path}.${String(prop)}`)
    },
    apply(_t, _thisArg, args) {
      shimLog(`call ${path}(${args.length} args)`)
      return makeApiStub(`${path}()`)
    },
    construct(_t, args) {
      shimLog(`construct new ${path}(${args.length} args)`)
      return makeApiStub(`${path}(instance)`) as object
    },
  })
}

const stubFallback = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === '__esModule') return false
      shimLog(`import ${String(prop)} (not yet implemented — stub)`)
      return makeApiStub(String(prop))
    },
    has(_t, prop) {
      return typeof prop === 'string' && KNOWN_EXPORTS.includes(prop)
    },
    ownKeys() {
      return [...KNOWN_EXPORTS, '__esModule']
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (prop === '__esModule' || (typeof prop === 'string' && KNOWN_EXPORTS.includes(prop))) {
        return { enumerable: true, configurable: true, writable: false, value: undefined }
      }
      return undefined
    },
  },
)

module.exports = {
  ...stubFallback,
  __esModule: false,
  // T20: components + navigation
  List,
  Grid,
  Detail,
  Form,
  ActionPanel,
  Action,
  useNavigation,
  // T21: imperative APIs
  Clipboard,
  showToast,
  Toast,
  LocalStorage,
  Cache,
  getPreferenceValues,
  environment,
  LaunchType,
  open,
  closeMainWindow,
  popToRoot,
  showHUD,
  showInFinder,
  trash,
  getSelectedText,
  getSelectedFinderItems,
  getApplications,
  getFrontmostApplication,
  getDefaultApplication,
  confirmAlert,
  updateCommandMetadata,
  Alert,
  PopToRootType,
  AI,
  OAuth,
  UnsupportedError,
  Icon,
  Color,
  Image,
}
