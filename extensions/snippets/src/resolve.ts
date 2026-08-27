import { Clipboard, getSelectedText } from '@raycast/api'
import { argumentSpecs, expand, type Context } from '@openray/placeholders'
import { getSnippetByName } from './storage'

export function takesArgument(body: string): boolean {
  return argumentSpecs(body).length > 0
}

/** Expands a snippet body for pasting: dynamic-placeholder substitution
 *  with no escaping (the result is plain text, not a URL), plus
 *  `{cursor}` removal — Raycast places the caret there, and the paste
 *  path has no caret control, so the marker is stripped rather than left
 *  visible in the pasted text. */
export async function resolveBody(body: string, argument: string): Promise<string> {
  const ctx: Context = {
    clipboard: async (offset) => (await Clipboard.readText({ offset })) ?? '',
    snippet: async (name) => (await getSnippetByName(name))?.body,
    selection: async () => {
      try {
        return await getSelectedText()
      } catch {
        return ''
      }
    },
  }
  if (argument !== '') ctx.argument = argument

  const expanded = await expand(body, ctx, (value) => value)
  return expanded.split('{cursor}').join('')
}
