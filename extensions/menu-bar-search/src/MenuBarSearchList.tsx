import { useEffect, useMemo, useState } from 'react'
import { Action, ActionPanel, Icon, List } from '@raycast/api'
import { activateMenuBarItem, listMenuBarItems, type MenuBarItem } from '@openray/extras'

function matchesQuery(item: MenuBarItem, needle: string): boolean {
  if (!needle) return true
  const lower = needle.toLowerCase()
  return item.title.toLowerCase().includes(lower) || item.path.some((segment) => segment.toLowerCase().includes(lower))
}

export function MenuBarSearchList() {
  const [appName, setAppName] = useState<string | null>(null)
  const [items, setItems] = useState<MenuBarItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void listMenuBarItems().then((listing) => {
      setAppName(listing.appName)
      setItems(listing.items)
      setIsLoading(false)
    })
  }, [])

  const filtered = useMemo(() => items.filter((item) => matchesQuery(item, query)), [items, query])

  const emptyTitle =
    items.length > 0
      ? 'No Matching Items'
      : appName
        ? `No Menu Bar Items Found for ${appName}`
        : 'No App Menu Found'
  const emptyDescription = items.length === 0 && !appName ? 'Focus an app before opening the palette.' : undefined

  return (
    <List isLoading={isLoading} searchText={query} onSearchTextChange={setQuery} searchBarPlaceholder="Search menu items…" navigationTitle="Search Menu Bar Items">
      <List.EmptyView title={emptyTitle} description={emptyDescription} />
      {filtered.map((item) => (
        <List.Item
          key={item.token}
          id={item.token}
          title={item.title}
          subtitle={item.path.length > 0 ? item.path.join(' → ') : undefined}
          accessories={[
            ...(item.shortcut ? [{ text: item.shortcut }] : []),
            ...(item.enabled ? [] : [{ tag: 'Disabled' }]),
          ]}
          actions={
            item.enabled ? (
              <ActionPanel>
                <Action title="Activate" icon={Icon.ArrowRight} onAction={() => void activateMenuBarItem(item.token)} />
              </ActionPanel>
            ) : undefined
          }
        />
      ))}
    </List>
  )
}
