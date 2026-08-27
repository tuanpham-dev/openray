import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { List, ActionPanel, Action, Detail, useNavigation, showToast, Toast } from '@raycast/api'
import * as storage from './storage'
import type { ChatRecord, MessageRecord } from './storage'
import * as engine from './engine'
import { getAiSettings } from './settings'
import { createReactiveSlot, openOrFocusWindow } from './window'

const CHAT_WINDOW_KEY = 'chat'
/** ~20 commits/s ceiling (Constraints section) — deltas are buffered in a
 *  ref and flushed to React state at most this often, so a fast-streaming
 *  provider doesn't turn every token into its own IPC round trip /
 *  `ui.commit`. Neither the reconciler nor any provider does this
 *  batching on its own (confirmed by reading `reconciler.ts`'s
 *  `flushCommit` — it fires synchronously on every commit) — this is the
 *  one place T27 needed a genuinely new mechanism, kept local to the
 *  extension rather than a reconciler-wide change. */
const STREAM_FLUSH_MS = 50

const activeChatSlot = createReactiveSlot<string | null>('activeChatId', null)
/** A one-shot query to auto-send once the Chat window (re)opens — set by
 *  the `quick-ai` command (Tab-from-root with a non-empty search query)
 *  and consumed by `ChatWindowView`'s mount effect. */
const pendingQuerySlot = createReactiveSlot<string | null>('pendingQuery', null)

function preview(content: string, max = 60): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine || '(empty)'
}

interface ChatWindowViewProps {
  quick?: boolean
}

function ChatWindowView({ quick }: ChatWindowViewProps) {
  const chatId = useSyncExternalStore(activeChatSlot.subscribe, activeChatSlot.get)
  const [chats, setChats] = useState<ChatRecord[]>([])
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { push } = useNavigation()

  const streamBuffer = useRef('')
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshChats = () => void storage.listChats().then(setChats)

  useEffect(() => {
    refreshChats()
  }, [])

  // Reactive (not mount-only): a `quick-ai` launch while this window is
  // already open (Tab-from-root a second time) sets the slot again — this
  // must still fire without a remount, unlike a plain "run once" effect.
  const pendingQuery = useSyncExternalStore(pendingQuerySlot.subscribe, pendingQuerySlot.get)
  useEffect(() => {
    if (!pendingQuery) return
    pendingQuerySlot.set(null)
    void send(pendingQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuery])

  useEffect(() => {
    if (!chatId) return
    void storage.listMessages(chatId).then(setMessages)
  }, [chatId])

  useEffect(() => {
    return () => {
      if (flushTimer.current) clearInterval(flushTimer.current)
    }
  }, [])

  const startFlushTimer = () => {
    if (flushTimer.current) return
    flushTimer.current = setInterval(() => {
      setStreamingText(streamBuffer.current)
    }, STREAM_FLUSH_MS)
  }
  const stopFlushTimer = () => {
    if (flushTimer.current) {
      clearInterval(flushTimer.current)
      flushTimer.current = null
    }
    setStreamingText(streamBuffer.current)
  }

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim()
    if (!text || sending) return
    setDraft('')
    setError(null)

    let id = chatId
    if (!id) {
      id = await storage.createChat(quick ? 'Quick AI' : 'New Chat', undefined, undefined, Boolean(quick))
      activeChatSlot.set(id)
      refreshChats()
    }

    const settings = await getAiSettings()
    const model = (quick ? settings.aiQuickModel : '') || settings.aiDefaultModel

    setSending(true)
    streamBuffer.current = ''
    setStreamingText('')
    startFlushTimer()
    try {
      await engine.runSend({ chatId: id, model, content: text, profile: settings.aiProfile, skillDirs: settings.aiSkillDirs }, (delta) => {
        streamBuffer.current += delta
      })
      const refreshed = await storage.listMessages(id)
      setMessages(refreshed)
      refreshChats()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      stopFlushTimer()
      setSending(false)
      streamBuffer.current = ''
      setStreamingText('')
    }
  }

  const regenerate = async () => {
    if (!chatId || sending || messages.length === 0) return
    setError(null)
    const settings = await getAiSettings()
    const chat = chats.find((c) => c.id === chatId)
    const model = chat?.model || settings.aiDefaultModel

    setSending(true)
    streamBuffer.current = ''
    setStreamingText('')
    startFlushTimer()
    try {
      await engine.runRegenerate({ chatId, model, profile: settings.aiProfile, skillDirs: settings.aiSkillDirs }, (delta) => {
        streamBuffer.current += delta
      })
      setMessages(await storage.listMessages(chatId))
      refreshChats()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      stopFlushTimer()
      setSending(false)
      streamBuffer.current = ''
      setStreamingText('')
    }
  }

  const newChat = async () => {
    const id = await storage.createChat('New Chat', undefined, undefined, false)
    activeChatSlot.set(id)
    setMessages([])
    refreshChats()
  }

  const ordered = [...messages].reverse()

  return (
    <List
      searchText={draft}
      onSearchTextChange={setDraft}
      searchBarPlaceholder={quick ? 'Ask AI… (Enter to send)' : 'Ask AI… (Enter to send)'}
      navigationTitle={quick ? 'Quick AI' : 'AI Chat'}
      searchBarAccessory={
        !quick ? (
          <List.Dropdown tooltip="Chat" value={chatId ?? ''} onChange={(value) => activeChatSlot.set(value || null)}>
            {chats.map((chat) => (
              <List.Dropdown.Item key={chat.id} title={chat.title} value={chat.id} />
            ))}
          </List.Dropdown>
        ) : undefined
      }
      actions={
        <ActionPanel>
          <Action title="Send" shortcut={{ modifiers: [], key: 'return' }} onAction={() => void send()} />
          {!quick && <Action title="New Chat" shortcut={{ modifiers: ['cmd'], key: 'n' }} onAction={() => void newChat()} />}
          <Action title="Regenerate" shortcut={{ modifiers: ['cmd'], key: 'r' }} onAction={() => void regenerate()} />
          <Action
            title="Show Memory"
            onAction={() =>
              void storage.getMemory().then((memory) => push(<Detail markdown={memory || 'No memory yet.'} navigationTitle="Memory" />))
            }
          />
          <Action
            title="Clear Memory"
            onAction={() =>
              void storage.clearMemory().then(() => showToast({ style: Toast.Style.Success, title: 'Memory cleared' }))
            }
          />
        </ActionPanel>
      }
    >
      {draft.trim() && (
        <List.Item
          id="__send"
          title={`Send: "${draft.trim()}"`}
          icon="send"
          actions={
            <ActionPanel>
              <Action title="Send" onAction={() => void send()} />
            </ActionPanel>
          }
        />
      )}
      {sending && (
        <List.Item
          id="__streaming"
          title="Assistant"
          subtitle={preview(streamingText) || 'Thinking…'}
          actions={
            <ActionPanel>
              <Action title="View Full" onAction={() => push(<Detail markdown={streamingText || 'Thinking…'} navigationTitle="Assistant" />)} />
            </ActionPanel>
          }
        />
      )}
      {error && <List.Item id="__error" title="Error" subtitle={error} icon="alert" />}
      {ordered.map((message, index) => (
        <List.Item
          key={message.id}
          id={message.id}
          title={message.role === 'user' ? 'You' : 'Assistant'}
          subtitle={preview(message.content)}
          actions={
            <ActionPanel>
              <Action title="View Full" onAction={() => push(<Detail markdown={message.content} navigationTitle={message.role === 'user' ? 'You' : 'Assistant'} />)} />
              <Action.CopyToClipboard title="Copy" content={message.content} />
              {index === 0 && message.role === 'assistant' && <Action title="Regenerate" shortcut={{ modifiers: ['cmd'], key: 'r' }} onAction={() => void regenerate()} />}
              <Action
                title="Show Memory"
                onAction={() =>
                  void storage.getMemory().then((memory) => push(<Detail markdown={memory || 'No memory yet.'} navigationTitle="Memory" />))
                }
              />
              <Action
                title="Clear Memory"
                onAction={() =>
                  void storage.clearMemory().then(() => showToast({ style: Toast.Style.Success, title: 'Memory cleared' }))
                }
              />
            </ActionPanel>
          }
        />
      ))}
      {ordered.length === 0 && !sending && <List.EmptyView title="Ask anything" description="Configure a provider key in Settings → Extensions → AI first." />}
    </List>
  )
}

/** Opens (or focuses) the persistent Chat window. `chatId` of `undefined`
 *  leaves whatever chat is already active untouched (the plain "AI Chat"
 *  command); a real id redirects to it (agent rows, "Continue in Chat")
 *  even when the window is already open — same role
 *  `NotesWindowView`'s `useSyncExternalStore` plays for Notes. */
export async function openOrFocusChatWindow(chatId: string | null | undefined, quick: boolean): Promise<void> {
  if (chatId !== undefined) activeChatSlot.set(chatId)
  await openOrFocusWindow(CHAT_WINDOW_KEY, () => <ChatWindowView quick={quick} />, { title: quick ? 'Quick AI' : 'AI Chat', width: 720, height: 560 })
}

/** Sets the query `ChatWindowView`'s mount effect auto-sends once the
 *  window is (re)opened — call before `openOrFocusChatWindow`. */
export function setPendingQuery(query: string): void {
  pendingQuerySlot.set(query)
}

export { ChatWindowView }
