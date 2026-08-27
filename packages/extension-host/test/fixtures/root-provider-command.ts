/**
 * T14 fixture: a `root-provider`-mode command. No JSX, no React
 * involvement at all — just a plain default-exported listing function and
 * a named `execute` export, exactly the contract `runner.ts`'s
 * `runRootProviderList`/`runRootCommand` expect. Side-channels through
 * `globalThis.__fixtureEvents` (the same technique T9's
 * `interval-command.tsx`/`simple-command.tsx` fixtures use) so the test
 * can observe what actually ran without a real UI to inspect.
 */

function events(): string[] {
  return ((globalThis as Record<string, unknown>).__fixtureEvents ??= []) as string[]
}

export default async function listRootCommands() {
  events().push('list')
  return [
    { id: 'row-1', title: 'Row One', requiresArgument: false, needsConfirm: false, opensView: false },
    { id: 'row-2', title: 'Row Two', needsConfirm: true, opensView: false },
  ]
}

export async function execute(id: string, argument?: string): Promise<void> {
  events().push(`execute:${id}:${argument ?? ''}`)
}
