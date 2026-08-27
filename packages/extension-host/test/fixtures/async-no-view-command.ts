/** Mirrors the real, unmodified `8ball` store extension's exact shape
 * (`export default async function Command() {...}`, no JSX/hooks) — the
 * pattern that exposed T32's bug: `runCommand` used to hand this straight
 * to the reconciler as if it were a component, which can never work for
 * an async function (it returns a Promise, not a valid render value). */
export default async function Command(): Promise<void> {
  const events = ((globalThis as Record<string, unknown>).__fixtureEvents ??= []) as string[]
  events.push('async-no-view:start')
  await new Promise((resolve) => setTimeout(resolve, 1))
  events.push('async-no-view:done')
}
