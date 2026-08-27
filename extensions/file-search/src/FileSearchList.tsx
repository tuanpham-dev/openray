import { useEffect, useState } from 'react'
import { spawn, spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { Action, ActionPanel, Clipboard, List, open, showInFinder, showToast, Toast } from '@raycast/api'
import { queryFileSearch, type FileSearchEntry } from '@openray/extras'

const SEARCH_DEBOUNCE_MS = 120

function isAvailable(bin: string): boolean {
  return spawnSync('which', [bin]).status === 0
}

/** No native bridge method for this — Node's own `child_process` is
 *  enough (the extension host is a real Node sidecar). Tries `$TERMINAL`
 *  first, then a short list of common Linux terminal emulators; `cwd` on
 *  the spawned process is enough to open at the right directory without
 *  needing per-terminal working-directory flags. */
async function openInTerminal(path: string): Promise<boolean> {
  const dir = dirname(path)
  const candidates = [process.env.TERMINAL, 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'alacritty', 'kitty', 'xterm'].filter(
    (t): t is string => Boolean(t) && isAvailable(t),
  )
  const terminal = candidates[0]
  if (!terminal) return false
  spawn(terminal, [], { cwd: dir, detached: true, stdio: 'ignore' }).unref()
  return true
}

export function FileSearchList() {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<FileSearchEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      void queryFileSearch(query).then((results) => {
        if (!cancelled) {
          setEntries(results)
          setLoading(false)
        }
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  return (
    <List isLoading={loading} searchText={query} onSearchTextChange={setQuery} searchBarPlaceholder="Search files…" navigationTitle="Search Files">
      <List.EmptyView title={query ? 'No Matching Files' : 'No Files Indexed Yet'} description={query ? undefined : 'Indexing runs in the background — try again shortly.'} />
      {entries.map((entry) => (
        <List.Item
          key={entry.path}
          id={entry.path}
          title={entry.name}
          subtitle={entry.path}
          actions={
            <ActionPanel>
              <Action title="Open" onAction={() => void open(entry.path)} />
              <Action title="Reveal in Files" onAction={() => void showInFinder(entry.path)} />
              <Action title="Copy Path" onAction={() => void Clipboard.copy(entry.path)} />
              <Action
                title="Open in Terminal"
                onAction={() =>
                  void openInTerminal(entry.path).then((found) => {
                    if (!found) void showToast({ style: Toast.Style.Failure, title: 'Open in Terminal', message: 'No terminal emulator found' })
                  })
                }
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
