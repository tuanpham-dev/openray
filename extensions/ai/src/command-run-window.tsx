import { useEffect } from 'react'
import { useNavigation } from '@raycast/api'
import type { CommandRecord } from './storage'
import { runAiCommand } from './search-ai-commands'
import { openExtensionWindow } from '@openray/extras'

type ExtensionWindowHandle = Awaited<ReturnType<typeof openExtensionWindow>>

/** Unlike the Chat window (one persistent instance users expect to keep
 *  showing history), a command run's output is inherently ephemeral per
 *  invocation — matching native, where an AI Command's result was always
 *  a fresh palette view, never a reused one. So a fresh window each time
 *  rather than `openOrFocusWindow`'s reuse-and-redirect pattern; the
 *  previous run's window (if the user never closed it) is closed first
 *  so results from separate invocations don't pile up as orphaned
 *  windows. */
let current: ExtensionWindowHandle | null = null

function CommandRunHost({ command }: { command: CommandRecord }) {
  const { push } = useNavigation()
  useEffect(() => {
    runAiCommand(command, push)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

export async function openOrFocusCommandRunWindow(command: CommandRecord): Promise<void> {
  if (current) {
    current.close()
    current = null
  }
  current = await openExtensionWindow(<CommandRunHost command={command} />, { title: command.name, decorations: false, width: 640, height: 520 })
}
