import { useEffect, useState } from 'react'
import { Action, ActionPanel, Clipboard, confirmAlert, List, showHUD, showToast, Toast } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'
import { deleteSnippet, listSnippets, type Snippet } from './storage'
import { resolveBody, takesArgument } from './resolve'
import { SnippetForm } from './create-snippet'

export default function SearchSnippets() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = async () => {
    setIsLoading(true)
    setSnippets(await listSnippets())
    setIsLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const pasteSnippet = async (snippet: Snippet) => {
    if (takesArgument(snippet.body)) {
      // Argument-taking snippets are launched through root search's own
      // argument-bar flow, not from inside this management list — nudge
      // instead of silently pasting an empty value.
      await showToast({ style: Toast.Style.Failure, title: 'This snippet needs an argument', message: 'Launch it from the main search instead.' })
      return
    }
    const expanded = await resolveBody(snippet.body, '')
    await Clipboard.paste(expanded)
  }

  const copySnippet = async (snippet: Snippet) => {
    const expanded = await resolveBody(snippet.body, '')
    await Clipboard.copy(expanded)
    await showHUD('Copied to Clipboard')
  }

  const remove = async (snippet: Snippet) => {
    const confirmed = await confirmAlert({ title: `Delete "${snippet.name}"?`, message: 'This cannot be undone.' })
    if (!confirmed) return
    await deleteSnippet(snippet.id)
    await refreshRootCommands()
    await showHUD('Snippet Deleted')
    await refresh()
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search snippets…" navigationTitle="Snippets">
      <List.EmptyView
        title="No Snippets"
        description="Create a snippet to get started."
        actions={
          <ActionPanel>
            <Action.Push title="Create Snippet" target={<SnippetForm onSaved={refresh} />} />
          </ActionPanel>
        }
      />
      {snippets.map((snippet) => (
        <List.Item
          key={snippet.id}
          id={snippet.id}
          title={snippet.name}
          subtitle={snippet.body}
          keywords={snippet.keyword ? [snippet.keyword] : []}
          accessories={snippet.keyword ? [{ tag: snippet.keyword }] : []}
          actions={
            <ActionPanel>
              <Action title="Paste" onAction={() => void pasteSnippet(snippet)} />
              <Action title="Copy to Clipboard" onAction={() => void copySnippet(snippet)} />
              <Action.Push title="Edit" target={<SnippetForm snippet={snippet} onSaved={refresh} />} />
              <Action.Push title="Create Snippet" target={<SnippetForm onSaved={refresh} />} />
              <Action title="Delete" style="destructive" onAction={() => void remove(snippet)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
