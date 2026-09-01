import { ControlClient } from './client.mjs'

/**
 * Runs a command in the running app and returns — the terminal equivalent
 * of clicking it in the palette, for the commands that have no palette UI
 * to click into in the first place (window presets, snippets, system
 * commands, no-view extension actions).
 *
 * A view-mode command (Store, Notes, most List/Grid/Form UIs) is rejected
 * by the app itself with a clear error — there's no window on this end of
 * the socket for it to render into.
 */
export async function run(id, { arguments: args = {}, json = false } = {}) {
  if (!id) throw new Error("openray run needs a command id — see 'openray list'")
  const client = await ControlClient.connect()
  try {
    await client.call('command.run', { id, arguments: args })
    process.stdout.write(json ? `${JSON.stringify({ id, ok: true })}\n` : `Ran ${id}\n`)
  } finally {
    client.close()
  }
}
