/**
 * Expands an AI Command prompt through the shared placeholder engine
 * (`@openray/placeholders`) — port of
 * `src-tauri/src/application/ai/engine.rs`'s `expand_command_prompt`.
 * `{webpage}` is not a token here — the caller substitutes it before
 * expansion, since fetching it is a network call (see `run-ai-command`).
 */
import { Clipboard, getSelectedText } from '@raycast/api'
import { expand, takesArgument, type Context } from '@openray/placeholders'

export { takesArgument }

/** Whether running this command needs the frontend to prompt for an
 *  argument first — true for `{argument}` and for `{webpage}`, which
 *  piggybacks on the same captured value as the URL to fetch. */
export function commandPromptRequiresArgument(prompt: string): boolean {
  return takesArgument(prompt) || prompt.includes('{webpage}')
}

export async function expandCommandPrompt(prompt: string, argument: string | undefined, namedArguments: Record<string, string>): Promise<string> {
  const clipboard = async (offset: number) => (await Clipboard.readText({ offset })) ?? ''
  // `{selection}` prefers the live selection but degrades to clipboard
  // content rather than expanding to nothing.
  const selection = async () => {
    let live = ''
    try {
      live = await getSelectedText()
    } catch {
      live = ''
    }
    if (live.trim()) return live
    return clipboard(0)
  }

  const ctx: Context = {
    clipboard,
    selection,
    namedArgument: async (name) => namedArguments[name],
  }
  if (argument) ctx.argument = argument

  return expand(prompt, ctx, (value) => value)
}
