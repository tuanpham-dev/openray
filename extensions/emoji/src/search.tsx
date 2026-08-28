import { useEffect, useState } from 'react'
import { Action, ActionPanel, Grid, LocalStorage } from '@raycast/api'
import { EMOJI_SECTIONS, type EmojiEntry } from './emojiData'

const COLUMNS = 10
const RECENTS_KEY = 'recents'
const RECENTS_MAX = 20
const RECENTS_TITLE = 'Recently Used'
const ALL_CATEGORIES = 'all'

/** Character → name, for labelling recents without a second dataset scan. */
const NAME_BY_CHAR = new Map<string, string>()
for (const section of EMOJI_SECTIONS) {
  for (const item of section.items) NAME_BY_CHAR.set(item.e, item.n)
}

async function loadRecents(): Promise<string[]> {
  const raw = await LocalStorage.getItem<string>(RECENTS_KEY)
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function GridEntry({ entry, onUse }: { entry: EmojiEntry; onUse: (char: string) => void }) {
  return (
    <Grid.Item
      content={entry.e}
      keywords={[entry.n]}
      actions={
        <ActionPanel>
          <Action.Paste title="Paste Emoji" content={entry.e} onPaste={() => onUse(entry.e)} />
          <Action.CopyToClipboard title="Copy Emoji" content={entry.e} onCopy={() => onUse(entry.e)} />
        </ActionPanel>
      }
    />
  )
}

export default function SearchEmoji() {
  const [searchText, setSearchText] = useState('')
  const [recents, setRecents] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  /** A section title, or `ALL_CATEGORIES` — the dropdown at the trailing
   *  edge of the search bar, the way Raycast's own emoji picker scopes the
   *  grid to one category. */
  const [category, setCategory] = useState(ALL_CATEGORIES)

  useEffect(() => {
    void loadRecents().then((loaded) => {
      setRecents(loaded)
      setIsLoading(false)
    })
  }, [])

  const rememberUse = (char: string) => {
    setRecents((current) => {
      const next = [char, ...current.filter((c) => c !== char)].slice(0, RECENTS_MAX)
      void LocalStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      return next
    })
  }

  const needle = searchText.trim().toLowerCase()
  const matches = (name: string) => !needle || name.includes(needle)

  // Recents span every category, so they only lead the grid while it shows
  // all of them — scoped to one category, the section would be a second,
  // unrelated answer to "show me Arrows".
  const showRecents = category === ALL_CATEGORIES
  const recentEntries: EmojiEntry[] = showRecents
    ? recents.map((char) => ({ e: char, n: NAME_BY_CHAR.get(char) ?? '' })).filter((entry) => matches(entry.n))
    : []
  const sections = category === ALL_CATEGORIES ? EMOJI_SECTIONS : EMOJI_SECTIONS.filter((section) => section.title === category)

  return (
    <Grid
      columns={COLUMNS}
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      navigationTitle="Emoji & Symbols"
      searchBarPlaceholder="Search emoji & symbols…"
      searchBarAccessory={
        <Grid.Dropdown tooltip="Filter by category" value={category} onChange={setCategory}>
          <Grid.Dropdown.Item title="All Categories" value={ALL_CATEGORIES} />
          {EMOJI_SECTIONS.map((section) => (
            <Grid.Dropdown.Item key={section.title} title={section.title} value={section.title} />
          ))}
        </Grid.Dropdown>
      }
    >
      {recentEntries.length > 0 && (
        <Grid.Section title={RECENTS_TITLE}>
          {recentEntries.map((entry) => (
            <GridEntry key={`recent-${entry.e}`} entry={entry} onUse={rememberUse} />
          ))}
        </Grid.Section>
      )}
      {sections.map((section) => {
        const filtered = section.items.filter((entry) => matches(entry.n))
        if (filtered.length === 0) return null
        return (
          <Grid.Section key={section.title} title={section.title}>
            {filtered.map((entry) => (
              <GridEntry key={entry.e} entry={entry} onUse={rememberUse} />
            ))}
          </Grid.Section>
        )
      })}
    </Grid>
  )
}
