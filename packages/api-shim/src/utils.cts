// Skeletal @raycast/utils stub for anything not yet implemented. See
// index.cts for why this is .cts (not .ts) and why the top-level object
// needs a concrete ownKeys list rather than being a fully-dynamic Proxy —
// both fixes here mirror index.cts exactly.

import { usePromise, useCachedState, useCachedPromise, useFetch, useLocalStorage } from './utils-hooks'

const KNOWN_EXPORTS = [
  'useExec',
  'useSQL',
  'useForm',
  'useFrontmostApplication',
  'useStreamJSON',
  'runAppleScript',
  'showFailureToast',
  'createDeeplink',
  'getFavicon',
  'getProgressIcon',
  'getAvatarIcon',
  'MutatePromise',
]

/** See `index.cts`'s `shimLog` for why `OPENRAY_SHIM_QUIET` exists. */
function utilsShimLog(message: string): void {
  if (process.env.OPENRAY_SHIM_QUIET) return
  process.stderr.write(`[api-shim/utils] ${message}\n`)
}

function makeUtilsStub(path: string): unknown {
  const target = function openrayUtilsStub() {}
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
      utilsShimLog(`access ${path}.${String(prop)}`)
      return makeUtilsStub(`${path}.${String(prop)}`)
    },
    apply(_t, _thisArg, args) {
      utilsShimLog(`call ${path}(${args.length} args)`)
      return makeUtilsStub(`${path}()`)
    },
    construct(_t, args) {
      utilsShimLog(`construct new ${path}(${args.length} args)`)
      return makeUtilsStub(`${path}(instance)`) as object
    },
  })
}

const stubFallback = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === '__esModule') return false
      utilsShimLog(`import ${String(prop)} (not yet implemented — stub)`)
      return makeUtilsStub(String(prop))
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
  usePromise,
  useCachedState,
  useCachedPromise,
  useFetch,
  useLocalStorage,
}
