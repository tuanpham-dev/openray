import { useCallback, useState, type ReactElement } from 'react'
import { globalSlot } from './global-slot'

interface NavigationContextValue {
  push: (view: ReactElement) => void
  pop: () => void
}

// Not React Context: NavigationRoot lives in the sidecar's own bundle
// (host.cjs), while `useNavigation` is called from *extension* code, which
// is compiled as a completely separate esbuild bundle (builder.ts, per
// extension). Even with react/react-reconciler correctly shared as real
// external requires (required for hooks to work at all — see
// extension-host/scripts/build.mjs's comment), a `createContext()` call
// produces a distinct object *per bundle it gets inlined into*, and React
// matches Provider/Consumer by that object's identity — so two separately-
// bundled copies of this file never see each other's Provider, and
// useContext silently falls back to the default value (confirmed
// empirically: "useNavigation() must be called from within a rendered
// command view" despite genuinely being inside NavigationRoot's tree).
// A `globalThis` slot (see global-slot.ts) has no such per-bundle identity
// problem. It doesn't need to be reactive either: `push`/`pop` just need to
// be *callable* — they mutate NavigationRoot's own React state, and
// NavigationRoot itself re-renders normally since it's all within one
// bundle (host.cjs)'s own react-reconciler instance.
const navigationSlot = globalSlot<NavigationContextValue>('navigation')

export function useNavigation(): NavigationContextValue {
  const nav = navigationSlot.get()
  if (!nav) throw new Error('useNavigation() must be called from within a rendered command view')
  return nav
}

/**
 * Owns the push/pop navigation stack for one mounted command and renders
 * whatever's on top of it. `mount()` wraps every command's root element in
 * this, so `useNavigation` works anywhere in the tree without extensions
 * having to set anything up themselves.
 */
export function NavigationRoot({ initial }: { initial: ReactElement }): ReactElement {
  const [stack, setStack] = useState<ReactElement[]>([initial])

  const push = useCallback((view: ReactElement) => {
    setStack((current) => [...current, view])
  }, [])

  const pop = useCallback(() => {
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current))
  }, [])

  // Assigned directly during render, not in an effect: a descendant like
  // Action.Push calls useNavigation() synchronously from its own render
  // body (not from an event handler), including on the very first commit —
  // an effect wouldn't have fired yet at that point. Safe to do unconditionally
  // here since push/pop are referentially stable (useCallback, no deps) and
  // this assignment is idempotent — it has no observable effect beyond
  // being available for the next synchronous read.
  navigationSlot.set({ push, pop })

  const top = stack[stack.length - 1]!
  return top
}
