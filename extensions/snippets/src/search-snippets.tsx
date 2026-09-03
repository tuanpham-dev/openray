import { useEffect, useState } from 'react'
import { Action, ActionPanel, Clipboard, confirmAlert, Icon, List, showHUD } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'
import { deleteSnippet, listSnippets, type Snippet } from './storage'
import { argumentField, resolveBody } from './resolve'
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

  const pasteSnippet = async (snippet: Snippet, values: Record<string, string>) => {
    const { text } = await resolveBody(snippet.body, values.argument ?? '')
    await Clipboard.paste(text)
  }

  const copySnippet = async (snippet: Snippet, values: Record<string, string>) => {
    const { text } = await resolveBody(snippet.body, values.argument ?? '')
    await Clipboard.copy(text)
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
            <Action.Push title="Create Snippet" icon={Icon.Plus} target={<SnippetForm onSaved={refresh} />} />
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
              {/* A snippet with a placeholder collects it in this list's
                  own search bar, exactly as root search does. It used to
                  refuse outright and point at root search instead, which
                  left the snippet visibly listed but unusable from the one
                  place you go to find it. */}
              <Action
                title="Paste"
                icon={Icon.Clipboard}
                arguments={argumentField(snippet.body)}
                onAction={(values) => void pasteSnippet(snippet, values)}
              />
              <Action
                title="Copy to Clipboard"
                icon="copy"
                arguments={argumentField(snippet.body)}
                onAction={(values) => void copySnippet(snippet, values)}
              />
              <Action.Push title="Edit" icon={Icon.Pencil} target={<SnippetForm snippet={snippet} onSaved={refresh} />} />
              <Action.Push title="Create Snippet" icon={Icon.Plus} target={<SnippetForm onSaved={refresh} />} />
              <Action title="Delete" icon={Icon.Trash} style="destructive" onAction={() => void remove(snippet)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
