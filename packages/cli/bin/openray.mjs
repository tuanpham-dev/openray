#!/usr/bin/env node
import { develop } from '../src/develop.mjs'
import { create } from '../src/create.mjs'
import { pack, publish } from '../src/pack.mjs'
import { run } from '../src/run.mjs'
import { list } from '../src/list.mjs'

const USAGE = `openray — develop, package, and drive OpenRay extensions

Usage:
  openray develop [dir]        Build the extension in [dir] and keep rebuilding it as you save
  openray create [dir] [tpl]   Scaffold a new extension (prompts for a template)
  openray pack [dir]           Build [dir] and write a .orx archive
  openray publish <dir> [...]  Pack every extension directory into a registry catalog
  openray list                 List command ids the running app can run
  openray run <id>             Run a command in the running app

Options:
  --out <dir>          Where pack/publish writes (default: ./dist)
  --arg <name=value>   Argument for 'run' (repeatable)
  --json               Machine-readable output for 'run'/'list'
  --help               Show this message

'develop', 'list', and 'run' talk to a running OpenRay; 'pack' and
'publish' do not, so they work in CI. 'run' only runs commands with no UI
of their own (window presets, snippets, system commands, and the like) —
a command that opens a view errors instead of launching.
`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg === '--out') {
      flags.out = argv[++index]
    } else if (arg === '--arg') {
      flags.arg ??= []
      flags.arg.push(argv[++index])
    } else if (arg?.startsWith('--')) {
      flags[arg.slice(2)] = true
    } else if (arg) {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function parseArguments(pairs = []) {
  return Object.fromEntries(
    pairs.map((pair) => {
      const eq = pair.indexOf('=')
      if (eq === -1) throw new Error(`--arg must be name=value, got "${pair}"`)
      return [pair.slice(0, eq), pair.slice(eq + 1)]
    }),
  )
}

// The first non-flag argument is the command, so `openray --help` and
// `openray pack --help` both work rather than the leading flag being taken
// for a command name.
const argv = process.argv.slice(2)
const commandIndex = argv.findIndex((arg) => !arg.startsWith('-'))
const command = commandIndex === -1 ? undefined : argv[commandIndex]
const { positional, flags } = parseArgs(commandIndex === -1 ? argv : argv.filter((_, index) => index !== commandIndex))

if (!command || flags.help || command === 'help') {
  process.stdout.write(USAGE)
  process.exit(0)
}

try {
  switch (command) {
    case 'develop':
    case 'dev':
      await develop(positional[0] ?? process.cwd())
      break
    case 'create':
      await create(positional[0], positional[1])
      break
    case 'pack':
      await pack(positional[0] ?? process.cwd(), flags.out)
      break
    case 'publish':
      await publish(positional.length > 0 ? positional : [process.cwd()], flags.out)
      break
    case 'list':
      await list({ json: flags.json === true })
      break
    case 'run':
      await run(positional[0], { arguments: parseArguments(flags.arg), json: flags.json === true })
      break
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
      process.exit(1)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
