import { useEffect, useState } from 'react'
import { Action, ActionPanel, List } from '@raycast/api'
import { canListWindows, closeWindow, focusWindow, listWindows, type WindowInfo } from '@openray/extras'

export default function SwitchWindows() {
  const [windows, setWindows] = useState<WindowInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [available, setAvailable] = useState(true)

  const refresh = async () => {
    setIsLoading(true)
    const [supported, list] = await Promise.all([canListWindows(), listWindows()])
    setAvailable(supported)
    setWindows(list)
    setIsLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const switchTo = async (window: WindowInfo) => {
    await focusWindow(window.id)
  }

  const close = async (window: WindowInfo) => {
    await closeWindow(window.id)
    await refresh()
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search windows…" navigationTitle="Switch Windows">
      <List.EmptyView
        title={available ? 'No Open Windows' : 'Window Switching Unavailable'}
        description={available ? undefined : "This platform doesn't support listing open windows."}
      />
      {windows.map((window) => (
        <List.Item
          key={window.id}
          id={window.id}
          icon={window.icon ?? undefined}
          title={window.title}
          subtitle={window.appName}
          actions={
            <ActionPanel>
              <Action title="Switch to Window" onAction={() => void switchTo(window)} />
              <Action title="Close Window" style="destructive" shortcut={{ modifiers: ['cmd'], key: 'backspace' }} onAction={() => void close(window)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
