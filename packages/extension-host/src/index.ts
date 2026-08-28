import { getCommandContext } from '@openray/api-shim/runtime'
import { RpcDispatcher, log } from './rpc'
import { registerHostMethods } from './loader'
import { registerRunnerMethods } from './runner'
import { installReactResolver } from './react-runtime'

// Before anything can mount: command bundles `require("react")` under the
// bare specifier (see builder.ts's `portableReactExternals`), and this is
// what points that at the same react the reconciler uses.
installReactResolver()

/**
 * The real stdout writer, captured before the redirect below replaces it.
 *
 * Frames must keep going out through this one — everything else that
 * reaches stdout is now diverted, and the protocol would divert itself.
 */
const writeFrame = process.stdout.write.bind(process.stdout)

const dispatcher = new RpcDispatcher(
  (bytes) => {
    writeFrame(bytes)
  },
  (method) => log(`notification: ${method}`),
)

/**
 * Anything an extension prints goes to stderr instead of stdout.
 *
 * stdout carries the length-prefixed binary frames this process speaks to
 * the platform over. A single `console.log` from an extension lands *inside*
 * a frame, and from that byte on the decoder is reading garbage: every
 * later `ui.commit` is lost and the command silently goes inert — it
 * renders once and then never responds again, with nothing in any log to
 * say why.
 *
 * Found in the wild rather than in review. The `hacker-news` extension logs
 * its cache age, so it worked perfectly on a cold cache and died on a warm
 * one; `console.log` for debugging is completely ordinary in the Raycast
 * ecosystem, and plenty of npm dependencies print on their own. Any of them
 * would have done this.
 *
 * Patching `process.stdout.write` rather than `console.log` covers all of
 * them at once — `console` writes through this method, and so does a
 * dependency that reaches for the stream directly.
 */
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')

  // Attributed to whichever command is currently mounted, so the platform
  // (and `openray develop`) can route it to the right extension.
  let extensionId = 'unknown'
  try {
    extensionId = getCommandContext().extensionId || 'unknown'
  } catch {
    // No command mounted — host-level output, which keeps the fallback id.
  }

  process.stderr.write(`[${extensionId}] ${text}`)
  const message = text.replace(/\n$/, '')
  if (message.length > 0) {
    dispatcher.notify('extension.log', { extensionId, message })
  }

  // `write(chunk, encoding?, callback?)` — the caller may be waiting on the
  // completion callback, so honor whichever argument is one.
  const callback = rest.find((argument) => typeof argument === 'function') as ((error?: Error | null) => void) | undefined
  callback?.()
  return true
}) as typeof process.stdout.write

registerHostMethods(dispatcher)
registerRunnerMethods(dispatcher)

process.stdin.on('data', (chunk: Buffer) => {
  void dispatcher.feed(chunk)
})

process.stdin.on('end', () => {
  process.exit(0)
})

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
})

log('extension host ready')
