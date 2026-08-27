/**
 * T21 fixture: a `root-provider`-mode command whose module also exports
 * `onQuery`, exercising `runner.ts`'s `runRootProviderList` (which must
 * report `supportsInlineQuery: true` for this module) and `runOnQuery`.
 */

function events(): string[] {
  return ((globalThis as Record<string, unknown>).__fixtureEvents ??= []) as string[]
}

export default async function listRootCommands() {
  events().push('list')
  return []
}

export async function execute(): Promise<void> {
  events().push('execute')
}

export async function onQuery(query: string, context: { aliases: Record<string, string> }) {
  events().push(`onQuery:${query}:${JSON.stringify(context.aliases)}`)
  if (!query) return null
  return { id: 'echo', title: `Echo: ${query}`, value: query }
}
