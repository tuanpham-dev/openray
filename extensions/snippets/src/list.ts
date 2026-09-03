import { Clipboard } from '@raycast/api'
import { listSnippets, getSnippet } from './storage'
import { resolveBody, takesArgument, type ResolvedSnippet } from './resolve'

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
  const resolved = await resolve(id, argument)
  if (!resolved) return
  await Clipboard.paste(resolved.text)
}

/** Resolves a snippet to final text + caret offset without pasting — the
 *  read half of `execute`, used by the native auto-expansion service
 *  (`extension.resolveSnippet` → `application::auto_expand`), which owns the
 *  clipboard, backspace-deletion of the typed keyword, paste, and caret
 *  placement itself. Returns `undefined` for an unknown id. */
export async function resolve(id: string, argument?: string): Promise<ResolvedSnippet | undefined> {
  const snippet = await getSnippet(id)
  if (!snippet) return undefined
  return resolveBody(snippet.body, argument ?? '')
}
