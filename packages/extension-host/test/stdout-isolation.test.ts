import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder, type RpcMessage } from '@openray/protocol'

/**
 * stdout carries the length-prefixed frame protocol. A single `console.log`
 * from an extension used to land inside a frame, after which the decoder
 * read garbage forever: the command rendered once and then went silently
 * inert, with nothing in any log to explain it.
 *
 * Found with the real `hacker-news` extension, which logs its cache age —
 * so it worked on a cold cache and died on a warm one. Driven through the
 * *built* host here, because the bug lives in how that process wires its
 * streams, not in any module it imports.
 */

const dirs: string[] = []
const HOST = join(__dirname, '..', 'dist', 'host.cjs')

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An extension whose command prints before it renders. */
function noisyExtension(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openray-noisy-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'noisy', title: 'Noisy', commands: [{ name: 'index', title: 'Index', mode: 'view' }] }),
  )
  writeFileSync(
    join(dir, 'src', 'index.tsx'),
    `import { List } from '@raycast/api'
console.log('chatty extension says hello')
process.stdout.write('and writes to the stream directly\\n')
export default function Command() {
  console.log('and again while rendering')
  return <List><List.Item title="rendered anyway" /></List>
}
`,
  )
  return dir
}

describe('extension output never corrupts the frame stream', () => {
  it('still delivers the UI commit when the command writes to stdout', async () => {
    process.env.OPENRAY_SHIM_QUIET = '1'
    const { buildExtensionInPlace } = await import('../src/builder')
    const dir = noisyExtension()
    const built = await buildExtensionInPlace(dir)
    expect(built.buildErrors).toEqual([])

    const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] })
    const decoder = new FrameDecoder()
    const messages: RpcMessage[] = []
    const stderr: string[] = []
    child.stdout.on('data', (chunk: Buffer) => messages.push(...decoder.push(chunk)))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))

    try {
      child.stdin.write(
        encodeFrame({
          jsonrpc: '2.0',
          id: 1,
          method: 'extension.runCommand',
          params: {
            extensionId: 'noisy',
            commandName: 'index',
            commandPath: join(dir, '.openray', 'build', 'index.js'),
            environment: { raycastVersion: '1.0.0', assetsPath: '', supportPath: '', isDevelopment: true, theme: 'dark' },
            platform: { os: 'linux', displayServer: 'x11', capabilities: {} },
          },
        } as unknown as RpcMessage),
      )

      const deadline = Date.now() + 20000
      const commit = await new Promise<RpcMessage | undefined>((resolve) => {
        const poll = setInterval(() => {
          const found = messages.find((m) => (m as { method?: string }).method === 'ui.commit')
          if (found || Date.now() > deadline) {
            clearInterval(poll)
            resolve(found)
          }
        }, 50)
      })

      // The whole point: the frames decoded cleanly despite the noise.
      expect(commit, 'no ui.commit survived the extension writing to stdout').toBeDefined()
      const nodes = (commit as unknown as { params: { commit: { snapshot: { nodes: Record<string, { props: { title?: string } }> } } } })
        .params.commit.snapshot.nodes
      expect(Object.values(nodes).some((node) => node.props?.title === 'rendered anyway')).toBe(true)

      // …and the output was not lost, just redirected to stderr.
      expect(stderr.join('')).toContain('chatty extension says hello')
      expect(stderr.join('')).toContain('and writes to the stream directly')
    } finally {
      child.kill()
    }
  }, 40000)
})
