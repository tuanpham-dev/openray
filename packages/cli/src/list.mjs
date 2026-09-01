import { ControlClient } from './client.mjs'

/**
 * Prints every command the running app knows about, with the exact id
 * `openray run` accepts — copy-pasteable, not a separate CLI id syntax to
 * keep in sync with the app's own.
 */
export async function list({ json = false } = {}) {
  const client = await ControlClient.connect()
  try {
    const { commands } = await client.call('command.list')
    if (json) {
      process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`)
      return
    }
    for (const command of commands) {
      const runnable = command.mode === 'action' || command.mode === 'no-view'
      const owner = command.extensionTitle ? ` [${command.extensionTitle}]` : ''
      const tag = runnable ? '' : `  (opens app — ${command.mode})`
      process.stdout.write(`${command.id}${owner}${tag}\n`)
    }
  } finally {
    client.close()
  }
}
