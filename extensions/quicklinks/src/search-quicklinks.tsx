import { useEffect, useState } from 'react'
import { Action, ActionPanel, confirmAlert, Icon, List, open, showHUD, showToast, Toast } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'
import { deleteQuicklink, listQuicklinks, type Quicklink } from './storage'
import { resolveUrl, takesArgument } from './resolve'
import { QuicklinkForm } from './create-quicklink'

export default function SearchQuicklinks() {
  const [quicklinks, setQuicklinks] = useState<Quicklink[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = async () => {
    setIsLoading(true)
    setQuicklinks(await listQuicklinks())
    setIsLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const runQuicklink = async (quicklink: Quicklink) => {
    if (takesArgument(quicklink.urlTemplate)) {
      // Argument-taking quicklinks are launched through root search's own
      // argument-bar flow, not from inside this management list — nudge
      // instead of silently opening with an empty value.
      await showToast({ style: Toast.Style.Failure, title: 'This quicklink needs an argument', message: 'Launch it from the main search instead.' })
      return
    }
    const url = await resolveUrl(quicklink.urlTemplate, '')
    await open(url)
  }

  const remove = async (quicklink: Quicklink) => {
    const confirmed = await confirmAlert({ title: `Delete "${quicklink.title}"?`, message: 'This cannot be undone.' })
    if (!confirmed) return
    await deleteQuicklink(quicklink.id)
    await refreshRootCommands()
    await showHUD('Quicklink Deleted')
    await refresh()
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search quicklinks…" navigationTitle="Quicklinks">
      <List.EmptyView
        title="No Quicklinks"
        description="Create a quicklink to get started."
        actions={
          <ActionPanel>
            <Action.Push title="Create Quicklink" icon={Icon.Plus} target={<QuicklinkForm onSaved={refresh} />} />
          </ActionPanel>
        }
      />
      {quicklinks.map((quicklink) => (
        <List.Item
          key={quicklink.id}
          id={quicklink.id}
          title={quicklink.title}
          subtitle={quicklink.urlTemplate}
          actions={
            <ActionPanel>
              <Action title="Open" icon={Icon.ExternalLink} onAction={() => void runQuicklink(quicklink)} />
              <Action.CopyToClipboard title="Copy Link" content={quicklink.urlTemplate} />
              <Action.Push title="Edit" icon={Icon.Pencil} target={<QuicklinkForm quicklink={quicklink} onSaved={refresh} />} />
              <Action.Push title="Create Quicklink" icon={Icon.Plus} target={<QuicklinkForm onSaved={refresh} />} />
              <Action title="Delete" icon={Icon.Trash} style="destructive" onAction={() => void remove(quicklink)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
