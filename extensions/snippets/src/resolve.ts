import { Clipboard, getSelectedText } from '@raycast/api'
import { argumentSpecs, expand, splitCursor, type Context } from '@openray/placeholders'
import { getSnippetByName } from './storage'

export function takesArgument(body: string): boolean {
  return argumentSpecs(body).length > 0
}

/** A resolved snippet ready to insert.
 *  - `text` — the fully-expanded body with every `{cursor}` marker removed.
 *  - `cursorOffset` — where the caret should land, as a count of Unicode
 *    code points from the start of `text` (so it matches Rust's
 *    `chars().count()` caret walk). The first `{cursor}` marker's position,
 *    or `text`'s length when there is none (caret at the end). */
export interface ResolvedSnippet {
  text: string
  cursorOffset: number
}

/** Expands a snippet body to final text, with no escaping (the result is
 *  plain text, not a URL), and reports where `{cursor}` was so the caret
 *  can be placed there after insertion. */
export async function resolveBody(body: string, argument: string): Promise<ResolvedSnippet> {
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
  return splitCursor(expanded)
}
