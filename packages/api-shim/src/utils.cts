// Skeletal @raycast/utils stub for anything not yet implemented. See
// index.cts for why this is .cts (not .ts) and why the top-level object
// needs a concrete ownKeys list rather than being a fully-dynamic Proxy —
// both fixes here mirror index.cts exactly.

import { usePromise, useCachedState } from './utils-hooks'

const KNOWN_EXPORTS = [
  'useFetch',
  'useCachedPromise',
  'useExec',
  'useSQL',
  'useForm',
  'useLocalStorage',
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

function utilsShimLog(message: string): void {
  process.stderr.write(`[api-shim/utils] ${message}\n`)
}

function makeUtilsStub(path: string): unknown {
  const target = function openrayUtilsStub() {}
  return new Proxy(target, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then' || prop === 'toJSON' || prop === '$$typeof') return undefined
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
}
