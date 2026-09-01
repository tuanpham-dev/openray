import { ControlClient } from './client.mjs'

/**
 * Runs a command in the running app — the terminal equivalent of clicking
 * it in the palette. A no-view command (window presets, snippets, system
 * commands) runs headlessly and this returns once it's done. A view-mode
 * command (Store, Notes, most List/Grid/Form UIs) instead brings the app
 * forward and opens it there, the same as a click or hotkey would; this
 * returns as soon as that's requested, not once the view has rendered.
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
