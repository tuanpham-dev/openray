import { Clipboard } from '@raycast/api'
import { listSnippets, getSnippet } from './storage'
import { resolveBody, takesArgument } from './resolve'

export default async function listRootCommands() {
  const snippets = await listSnippets()
  return snippets.map((snippet) => ({
    id: snippet.id,
    title: snippet.name,
    subtitle: 'Snippet',
    keywords: snippet.keyword ? [snippet.keyword] : [],
    requiresArgument: takesArgument(snippet.body),
  }))
}

export async function execute(id: string, argument?: string): Promise<void> {
  const snippet = await getSnippet(id)
  if (!snippet) return
  const expanded = await resolveBody(snippet.body, argument ?? '')
  await Clipboard.paste(expanded)
}
