import * as storage from './storage'
import { openOrFocusChatWindow } from './chat'
import { openOrFocusCommandRunWindow } from './command-run-window'

const AI_COMMAND_ROW_PREFIX = 'row.command.'
const AI_AGENT_ROW_PREFIX = 'row.agent.'

/** Contributes dynamic rows for every AI command and every agent — the 5
 *  static commands (Chat, Quick AI, Search AI Commands, Create AI
 *  Command, Manage MCP Servers) are ordinary manifest commands and need
 *  no row here (same split T26's `notes` extension established: `list`
 *  only carries *data*-backed rows, not manifest commands). */
export default async function listRootCommands() {
  await storage.seedBuiltinCommands()
  const commands = await storage.listCommands()
  const agents = await storage.listAgents()

  return [
    ...commands.map((c) => ({ id: `${AI_COMMAND_ROW_PREFIX}${c.id}`, title: c.name, subtitle: c.builtin ? 'Built-in AI Command' : 'AI Command' })),
    ...agents.map((a) => ({ id: `${AI_AGENT_ROW_PREFIX}${a.id}`, title: `New Chat with ${a.name}`, subtitle: 'Agent' })),
  ]
}

/** Activates one dynamically-contributed row. AI-command rows open (or
 *  focus) the Command Run window; agent rows start a fresh chat scoped to
 *  that agent and open (or focus) the Chat window. */
export async function execute(id: string): Promise<void> {
  if (id.startsWith(AI_COMMAND_ROW_PREFIX)) {
    const commandId = id.slice(AI_COMMAND_ROW_PREFIX.length)
    const command = await storage.getCommand(commandId)
    if (command) await openOrFocusCommandRunWindow(command)
    return
  }
  if (id.startsWith(AI_AGENT_ROW_PREFIX)) {
    const agentId = id.slice(AI_AGENT_ROW_PREFIX.length)
    const chatId = await storage.createChat('New Chat', agentId, undefined, false)
    await openOrFocusChatWindow(chatId, false)
  }
}
