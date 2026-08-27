import { useEffect } from 'react'

/**
 * T20 fixture: a `root-provider`-mode command whose rows can also open a
 * view — the default listing export and named `execute` export mirror
 * `root-provider-command.ts` (T14); the new named `view` export is what
 * `runner.ts`'s `runRootCommandView` mounts, receiving `{ id, argument }`
 * as its launch props (not the `{ arguments: {...} }` shape a real
 * manifest command's default export gets). Records mount/unmount per
 * row id into the same `globalThis.__fixtureEvents` side channel
 * `interval-command.tsx` uses, so a test can prove which row's view is
 * actually mounted/torn down.
 */

function events(): string[] {
  return ((globalThis as Record<string, unknown>).__fixtureEvents ??= []) as string[]
}

export default async function listRootCommands() {
  events().push('list')
  return [
    { id: 'row-1', title: 'Row One', opensView: true },
    { id: 'row-2', title: 'Row Two', opensView: true },
  ]
}

export async function execute(id: string, argument?: string): Promise<void> {
  events().push(`execute:${id}:${argument ?? ''}`)
}

export function view({ id, argument }: { id: string; argument?: string }): null {
  useEffect(() => {
    events().push(`view:mount:${id}:${argument ?? ''}`)
    return () => {
      events().push(`view:unmount:${id}`)
    }
  }, [id, argument])

  return null
}
