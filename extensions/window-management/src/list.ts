import { isAvailable, listDisplays } from '@openray/extras'
import { listWindowCommands } from './storage'
import { TABLE } from './table'

// "Search Window Commands"/"Create Window Command" don't appear in this
// listing — they're ordinary static `mode: "view"` manifest commands
// (package.json), already discoverable via root search on their own,
// the same way quicklinks'/snippets' search/create commands are.

export default async function listRootCommands() {
  if (!(await isAvailable())) return []

  const displays = await listDisplays()
  const multiDisplay = displays.length >= 2

  const presets = TABLE.filter((entry) => multiDisplay || (entry.kind.type !== 'next-display' && entry.kind.type !== 'previous-display')).map((entry) => ({
    id: entry.id,
    title: entry.title,
    subtitle: 'Window Management',
    icon: entry.icon,
    keywords: entry.keywords,
  }))

  const custom = await listWindowCommands()
  const customRows = custom.map((command) => ({
    id: command.id,
    title: command.title,
    subtitle: 'Window Management',
    icon: 'app-window',
  }))

  return [...presets, ...customRows]
}

export { execute } from './provider'
