/**
 * Makes a component namespace tolerant of members this shim doesn't have.
 *
 * Raycast's namespaces are deep and still growing — `Action` alone ships
 * dozens of variants (`Open`, `OpenWith`, `ShowInFinder`, `Trash`,
 * `ToggleQuickLook`, `PickDate`, …), and `Form` has pickers we don't
 * implement. An unimplemented member is not an inert gap: `Action.Trash`
 * evaluates to `undefined`, React throws "Element type is invalid" during
 * render, and the *entire command* fails to mount over a single entry in a
 * menu the user may never open. Measured across a 180-extension sample, 49
 * of them used at least one member we lack.
 *
 * A whitelist of known names would be stale the day it shipped; claiming
 * unknown names at lookup time never goes stale.
 *
 * Deliberately narrow: only a **capitalized string** property that is
 * otherwise `undefined` is claimed. `Style`, `prototype`, `$$typeof`,
 * lower-cased helpers and every symbol lookup behave exactly as before,
 * which is what keeps React's own element checks working.
 */
export function withFallbacks<T extends object>(base: T, make: (name: string) => unknown): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const existing = Reflect.get(target, prop, receiver)
      if (existing !== undefined || typeof prop !== 'string') return existing
      if (!/^[A-Z]/.test(prop)) return existing

      const fallback = make(prop)
      // Cached on the target so repeated renders see one component
      // identity — returning a fresh function each time would make React
      // unmount and remount the node on every render.
      Object.defineProperty(target, prop, { value: fallback, configurable: true })
      return fallback
    },
  })
}
