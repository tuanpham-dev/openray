import { resolve } from 'node:path'
import { ControlClient } from './client.mjs'

/**
 * The `npm run dev` half of extension development: attach this terminal to
 * the running app's dev mode, print what each rebuild did, and stop
 * watching on Ctrl-C.
 *
 * Every build decision stays in the app. That is the point — a CLI that
 * compiled anything itself would be a second pipeline, and the first thing
 * to make a dev build differ from a shipped one.
 */
export async function develop(dir) {
  const path = resolve(dir)

  const client = await ControlClient.connect((message) => {
    if (message.event === 'build') printBuild(message.payload)
    else if (message.event === 'log') process.stdout.write(`${message.payload?.message ?? ''}\n`)
  })

  const started = await client.call('develop.start', { path })
  process.stdout.write(`Developing ${started.title ?? started.id} from ${path}\n`)
  process.stdout.write('Watching for changes. Press Ctrl-C to stop.\n\n')

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    process.stdout.write('\nStopping…\n')
    try {
      // Best effort: the app may already be gone, which is the most common
      // reason a session ends.
      await client.call('develop.stop', { id: started.id })
    } catch {
      // Nothing useful to say — the watcher dies with the app anyway.
    }
    client.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())

  // Hold the process open; everything from here is event-driven.
  await new Promise(() => {})
}

function printBuild(build) {
  if (!build) return
  const when = new Date().toLocaleTimeString()
  if (build.errors?.length > 0) {
    process.stdout.write(`[${when}] build failed\n`)
    for (const error of build.errors) process.stdout.write(`  ${error}\n`)
    return
  }
  const commands = build.commands?.length ? ` (${build.commands.join(', ')})` : ''
  const manifest = build.manifestChanged ? ', manifest reloaded' : ''
  process.stdout.write(`[${when}] rebuilt in ${build.durationMs}ms${commands}${manifest}\n`)
}
