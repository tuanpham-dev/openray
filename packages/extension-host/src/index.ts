import { RpcDispatcher, log } from './rpc'
import { registerHostMethods } from './loader'
import { registerRunnerMethods } from './runner'

const dispatcher = new RpcDispatcher(
  (bytes) => {
    process.stdout.write(bytes)
  },
  (method) => log(`notification: ${method}`),
)

registerHostMethods(dispatcher)
registerRunnerMethods(dispatcher)

process.stdin.on('data', (chunk: Buffer) => {
  void dispatcher.feed(chunk)
})

process.stdin.on('end', () => {
  process.exit(0)
})

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})

log('extension host ready')
