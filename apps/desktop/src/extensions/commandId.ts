/** Mirrors extension_command_id() in src-tauri/src/application/extension_commands.rs. */
export function parseExtensionCommandId(id: string): { extensionId: string; commandName: string } | null {
  const match = /^ext:(.+):([^:]+)$/.exec(id)
  if (!match) return null
  const [, extensionId, commandName] = match
  if (!extensionId || !commandName) return null
  return { extensionId, commandName }
}
