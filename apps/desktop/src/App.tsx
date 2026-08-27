import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { listen } from '@tauri-apps/api/event'
import { hidePalette } from './ipc/window'
import { search, runCommand, runCommandWithArgument, type InlineRow } from './ipc/search'
import { openSettings } from './ipc/settings'
import { SearchBar } from './components/SearchBar'
import { ResultList } from './components/ResultList'
import { ListItem } from './components/ListItem'
import { InlineCard } from './components/InlineCard'
import { Footer } from './components/Footer'
import { ActionPanel } from './components/ActionPanel'
import { QuicklinkArgumentBar } from './features/quicklinks/QuicklinkArgumentBar'
import { ConfirmView } from './features/system/ConfirmView'
import { needsConfirmation } from './state/systemCommands'
import { useListNavigation } from './components/useListNavigation'
import { isOverlayOpen } from './components/overlay'
import { ThemeProvider } from './theme/ThemeProvider'
import { getActionsForItem, type PaletteAction } from './state/actions'
import { ClipboardIcon, CopyIcon } from './components/icons'
import type { PaletteView } from './state/navigation'
import type { PaletteItem } from './components/types'
import { ExtensionView } from './extensions/TreeRenderer'
import { extensionTreeStore } from './extensions/registry'
import { startExtensionEventBridge, type ExtensionConfirmAlertPayload, type ExtensionToastPayload } from './extensions/eventBridge'
import { ExtensionConfirmAlert, Hud, Toast } from './extensions/Toast'
import { parseExtensionCommandId } from './extensions/commandId'
import { runExtensionCommand, unmountExtensionCommand } from './ipc/extensionHost'
import { useAppSettings } from './state/appSettings'
import './theme/tokens.css'
import './components/palette.css'
import './App.css'

const SEARCH_DEBOUNCE_MS = 80

function Palette() {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<PaletteItem[]>([])
  const [inlineRows, setInlineRows] = useState<InlineRow[]>([])
  const [actionPanelOpen, setActionPanelOpen] = useState(false)
  const [view, setView] = useState<PaletteView>({ type: 'search' })
  const [argumentValue, setArgumentValue] = useState('')
  const [toast, setToast] = useState<ExtensionToastPayload | null>(null)
  const [hud, setHud] = useState<string | null>(null)
  const [confirmAlert, setConfirmAlert] = useState<ExtensionConfirmAlertPayload | null>(null)

  const inSearchView = view.type === 'search'
  const latestSearchRequestId = useRef(0)
  const { popToRootDelay } = useAppSettings()
  const hiddenAtRef = useRef<number | null>(null)

  useEffect(() => {
    void startExtensionEventBridge(
      (payload) => setToast(payload.hide ? null : payload),
      (payload) => setHud(payload.title),
      (payload) => setConfirmAlert(payload),
    )
  }, [])

  useEffect(() => {
    if (!toast || toast.hide) return
    // An ANIMATED toast represents work still in progress: it stays until
    // the extension hides it, and auto-dismissing would claim the work
    // finished. One carrying actions stays too — dismissing it would take
    // the choice away mid-decision.
    if (toast.style === 'ANIMATED' || toast.primaryAction || toast.secondaryAction) return
    const timer = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!hud) return
    const timer = setTimeout(() => setHud(null), 2000)
    return () => clearTimeout(timer)
  }, [hud])

  /** Rendered by every view, so a toast (or a confirmAlert) raised from
   * any context is seen. */
  const overlays = (
    <>
      {toast && !toast.hide && <Toast toast={toast} onDismiss={() => setToast(null)} />}
      {hud && <Hud title={hud} />}
      {confirmAlert && <ExtensionConfirmAlert alert={confirmAlert} onResolved={() => setConfirmAlert(null)} />}
    </>
  )

  useEffect(() => {
    if (!inSearchView) return
    const timer = setTimeout(() => {
      const requestId = ++latestSearchRequestId.current
      void search(query).then((result) => {
        if (requestId !== latestSearchRequestId.current) return
        setItems(result.items)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, inSearchView])

  // T21: an inline-capable extension's `onQuery` round trip is a separate,
  // slower async hop than `search()` itself (see
  // `application::inline_query`'s doc comment) — its rows arrive later,
  // via this event, not as part of the debounced `search()` call above.
  // Staleness is already resolved backend-side (a stale in-flight query's
  // reply is dropped before this event is ever emitted), so every event
  // that does arrive here is safe to apply as-is.
  useEffect(() => {
    const unlisten = listen<{ rows: InlineRow[] }>('inline-rows', (event) => {
      setInlineRows(event.payload.rows)
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  /**
   * Launches an extension command by its parsed id, optionally with the
   * argument-bar's collected value — shared between `launchItem`'s direct
   * `extensionCommand` branch (no argument) and the `quicklink-argument`
   * view's Enter handler (which reaches here instead of the generic
   * `runCommandWithArgument` specifically so a *view*-mode command still
   * opens its view once mounted; see `run_extension_command`'s doc
   * comment). Shares the same missing-preferences/toast failure handling
   * either call site would otherwise duplicate.
   */
  const launchExtensionCommand = useCallback((extensionId: string, commandName: string, argument?: string) => {
    extensionTreeStore.reset()
    void runExtensionCommand(extensionId, commandName, argument)
      .then((mode) => {
        if (mode === 'view') setView({ type: 'extension', extensionId, commandName })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (message.startsWith('missing_required_preferences:')) {
          const missing = message.slice('missing_required_preferences:'.length)
          setView({ type: 'search' })
          setToast({
            id: 'missing-preferences',
            style: 'FAILURE',
            title: 'Preferences required',
            message: `Configure "${missing}" in Settings → Extensions before running this command.`,
          })
          void openSettings()
          return
        }
        setToast({ id: 'run-command-error', style: 'FAILURE', title: 'Command failed', message })
      })
  }, [])

  /**
   * Primary-activation handling shared between a normal click/Enter
   * (`onActivate`) and a global hotkey bound directly to this command (see
   * the `hotkey-command` listener below) — both land the same navigation
   * for view-shaped items. Returns whether it took over navigation; `false`
   * means the caller should fall through to the item's default action.
   */
  const launchItem = useCallback((item: PaletteItem): boolean => {
    if (item.requiresArgument) {
      setArgumentValue('')
      setView({ type: 'quicklink-argument', item })
      return true
    }

    // Must run before the `extensionCommand` branch below: a T14
    // root-provider-contributed row is `kind === 'extensionCommand'` too,
    // and its own `needsConfirm` flag would never be reached otherwise —
    // that branch launches unconditionally.
    if (needsConfirmation(item.needsConfirm)) {
      setView({ type: 'confirm', item })
      return true
    }

    if (item.kind === 'extensionCommand') {
      const parsed = parseExtensionCommandId(item.id)
      if (parsed) launchExtensionCommand(parsed.extensionId, parsed.commandName)
      return true
    }

    return false
  }, [launchExtensionCommand])

  /**
   * The primary action for a command that isn't a view (an app launch, a
   * system command, …): run it immediately, unless it's one of the
   * destructive ids that must be confirmed first. Passed into
   * `getActionsForItem` so the Actions panel's "Open" entry can't bypass
   * the same check `launchItem` applies to Enter.
   */
  const activateItem = useCallback((item: PaletteItem) => {
    if (needsConfirmation(item.needsConfirm)) {
      setView({ type: 'confirm', item })
      return
    }
    void runCommand(item.id)
  }, [])

  useEffect(() => {
    const unlisten = listen<PaletteItem>('hotkey-command', (event) => {
      launchItem(event.payload)
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [launchItem])

  // Tears down a mounted extension command's own timers/effects the moment
  // its view stops being current — every back/close path for an extension
  // view goes through a `setView` call that changes `view` away from this
  // command's `{ type: 'extension', ... }` object, which is exactly what
  // this cleanup fires on. Without this, a no-view-bound `runCommand` call
  // was the only thing that ever tore a command down (T9); with concurrent
  // mounts there's no guarantee a next launch ever comes.
  useEffect(() => {
    if (view.type !== 'extension') return
    const { extensionId, commandName } = view
    return () => {
      void unmountExtensionCommand(extensionId, commandName)
    }
  }, [view])

  // popToRoot()/closeMainWindow() from an extension: back to the root
  // search view, optionally clearing the query (Raycast's default for
  // popToRoot).
  useEffect(() => {
    const unlisten = listen<{ clearSearchBar?: boolean }>('extension-pop-to-root', (event) => {
      setView({ type: 'search' })
      if (event.payload.clearSearchBar) setQuery('')
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  // Raycast-style "Pop to Root Search": how long after the palette is
  // hidden its query/view/selection reset back to root search on next
  // show. `palette-hidden` just timestamps the hide; the actual decision
  // (and reset, mirroring the extension-pop-to-root handler above) happens
  // on the following `palette-shown`, since "never"/"immediately" are
  // meaningless without knowing whether the palette is being reopened now.
  useEffect(() => {
    const unlistenHidden = listen('palette-hidden', () => {
      hiddenAtRef.current = Date.now()
    })
    const unlistenShown = listen('palette-shown', () => {
      const hiddenAt = hiddenAtRef.current
      hiddenAtRef.current = null
      if (popToRootDelay === 'never' || hiddenAt === null) return
      const elapsedMs = Date.now() - hiddenAt
      const dueMs = popToRootDelay === 'immediately' ? 0 : Number(popToRootDelay) * 1000
      if (elapsedMs >= dueMs) {
        setView({ type: 'search' })
        setQuery('')
        setArgumentValue('')
      }
    })
    return () => {
      void unlistenHidden.then((fn) => fn())
      void unlistenShown.then((fn) => fn())
    }
  }, [popToRootDelay])

  const onActivate = useCallback(
    (index: number, secondary?: boolean, shift?: boolean) => {
      if (index < inlineRows.length) {
        // No second round trip back into the extension to activate — the
        // row already carries everything Enter (or a shortcut variant)
        // needs. Mirrors native calculator's three-way split: ↵ copies
        // `value` (the formatted answer), ⌘↵ copies `valueRaw` (falling
        // back to `value` when a row has no separate raw form), ⌘⇧↵
        // copies `"<subtitle> = <value>"` — composed here, not carried as
        // its own field, since `subtitle` (the expression/question) and
        // `value` (the answer) already say everything it needs.
        const row = inlineRows[index]
        if (row?.commandName && row.extensionId) {
          // T26: an activatable row (notes' quick-capture) — Enter only;
          // no secondary/shift variant, unlike the copy-value rows below
          // (disclosed simplification vs. native's separate ⌘↵ "create
          // silently" behavior — see plans/refactor-extension-platform.md's
          // T26 notes).
          launchExtensionCommand(row.extensionId, row.commandName, row.argument)
          void hidePalette()
          return
        }
        if (row?.value) {
          const text = !secondary ? row.value : shift ? `${row.subtitle ?? row.title} = ${row.value}` : (row.valueRaw ?? row.value)
          void writeText(text).catch((err: unknown) => {
            setToast({
              id: 'copy-inline-row-error',
              style: 'FAILURE',
              title: 'Copy failed',
              message: err instanceof Error ? err.message : String(err),
            })
          })
          void hidePalette()
        }
        return
      }

      const item = items[index - inlineRows.length]
      if (!item) return

      if (!secondary && launchItem(item)) return

      const actions = getActionsForItem(item, activateItem)
      const action = secondary ? actions[1] : actions[0]
      void action?.onAction()
    },
    [items, inlineRows, launchItem, activateItem, launchExtensionCommand],
  )

  const { selectedIndex, setSelectedIndex } = useListNavigation(
    inlineRows.length + items.length,
    onActivate,
    inSearchView && !actionPanelOpen,
    query,
  )

  const selectedItem = selectedIndex >= inlineRows.length ? items[selectedIndex - inlineRows.length] : undefined

  // An inline row (calculator, translate, …) isn't a PaletteItem, so it
  // has no entry in getActionsForItem — it gets its own action set,
  // mirroring native calculator's "Copy Answer" / "Copy Unformatted
  // Answer" / "Copy Question and Answer" (its fourth action, "Put Answer
  // in Search Bar", mutated the root query text directly — a capability
  // no `InlineRow` exposes, so it's a disclosed gap, not carried here).
  // "Copy Unformatted Answer" always appears alongside "Copy Answer" when
  // there's a value to copy (falling back to `value` itself when a row
  // has no distinct `valueRaw` — matches native always offering all three
  // actions, even for an integer answer where the formatted and raw forms
  // happen to be identical); "Copy Question and Answer" only appears when
  // the row has a `subtitle` to combine with — translate's inline row,
  // for instance, has one, but not every provider will.
  const inlineRowActions = useMemo<PaletteAction[]>(() => {
    const inSelectedRange = selectedIndex < inlineRows.length
    const row = inSelectedRange ? inlineRows[selectedIndex] : undefined
    if (!row?.value) return []
    const value = row.value
    const valueRaw = row.valueRaw ?? value

    const actions: PaletteAction[] = [
      { id: 'copy-inline-value', title: 'Copy Answer', icon: <ClipboardIcon size={15} />, shortcut: '↵', onAction: () => writeText(value) },
      {
        id: 'copy-inline-value-raw',
        title: 'Copy Unformatted Answer',
        icon: <CopyIcon size={15} />,
        shortcut: '⌘↵',
        onAction: () => writeText(valueRaw),
      },
    ]
    if (row.subtitle) {
      const combined = `${row.subtitle} = ${value}`
      actions.push({
        id: 'copy-inline-combined',
        title: 'Copy Question and Answer',
        icon: <CopyIcon size={15} />,
        shortcut: '⌘⇧↵',
        onAction: () => writeText(combined),
      })
    }
    return actions
  }, [selectedIndex, inlineRows])

  const panelActions = useMemo<PaletteAction[]>(() => {
    if (inlineRowActions.length > 0) return inlineRowActions
    return selectedItem ? getActionsForItem(selectedItem, activateItem) : []
  }, [inlineRowActions, selectedItem, activateItem])

  const handleEscape = useCallback(() => {
    // An open Actions panel — this view's or a sub-view's — closes
    // itself; navigating away here would skip past it.
    if (isOverlayOpen()) return
    if (!inSearchView) {
      setView({ type: 'search' })
      setArgumentValue('')
    } else {
      void hidePalette()
    }
  }, [inSearchView])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Claim the event. Without preventDefault the page reports Escape
        // "unhandled" to WebKitGTK, whose two-pass key handling then
        // re-dispatches it to the native widget asynchronously — but this
        // handler hides the window first, so the re-dispatch is lost and
        // WebKit's forward-next-key-to-native flag stays armed across the
        // hide. The next key press after a re-show was then routed to the
        // native widget instead of the page: the reopened palette's first
        // keystroke silently vanished ("test" → "est", or a first Escape
        // that wouldn't close).
        event.preventDefault()
        handleEscape()
        return
      }

      if (view.type === 'quicklink-argument' && event.key === 'Enter') {
        event.preventDefault()
        // Extension commands go through the mode-aware launch path (not
        // the generic runCommandWithArgument) so a *view*-mode command
        // still opens its view once mounted — see launchExtensionCommand's
        // doc comment.
        const parsed = view.item.kind === 'extensionCommand' ? parseExtensionCommandId(view.item.id) : null
        if (parsed) {
          launchExtensionCommand(parsed.extensionId, parsed.commandName, argumentValue)
        } else {
          void runCommandWithArgument(view.item.id, argumentValue)
        }
        // Back to root: most no-view commands (a headless quicklink open,
        // for instance) are about to hide the palette anyway, but a compact
        // script command keeps it open to show its toast, and the spent
        // argument bar shouldn't still be there behind it. A fullOutput
        // script's started event immediately routes to its view. An
        // extension command's own resolved mode overrides this to
        // 'extension' asynchronously, once the launch call returns.
        setView({ type: 'search' })
        setArgumentValue('')
        return
      }

      if (view.type === 'confirm' && event.key === 'Enter') {
        event.preventDefault()
        void runCommand(view.item.id)
        setView({ type: 'search' })
        return
      }

      if (inSearchView && event.key === 'Tab' && query.trim().length > 0) {
        event.preventDefault()
        launchExtensionCommand('ai', 'quick-ai-command', query.trim())
        return
      }

      if (inSearchView && event.key === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        if (panelActions.length > 0) {
          setActionPanelOpen((open) => !open)
        }
        return
      }

      if (event.key === ',' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        void openSettings()
        void hidePalette()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actionPanelOpen, inSearchView, view, argumentValue, items.length, selectedIndex, panelActions, handleEscape, query, launchExtensionCommand])

  if (view.type === 'extension') {
    return (
      <>
        <ExtensionView onBack={() => setView({ type: 'search' })} />
        {overlays}
      </>
    )
  }


  if (view.type === 'confirm') {
    return (
      <div className="palette">
        <ConfirmView
          item={view.item}
          onConfirm={() => {
            void runCommand(view.item.id)
            setView({ type: 'search' })
          }}
          onCancel={() => setView({ type: 'search' })}
        />
        <Footer context={view.item.title} primaryActionLabel="Confirm" />
        {overlays}
      </div>
    )
  }

  if (view.type === 'quicklink-argument') {
    return (
      <div className="palette">
        <QuicklinkArgumentBar title={view.item.title} value={argumentValue} onChange={setArgumentValue} />
        <div className="openray-flex-spacer" />
        <Footer primaryActionLabel="Open" />
      </div>
    )
  }

  return (
    <div className="palette">
      <SearchBar value={query} onChange={setQuery} />
      {inlineRows.map((row, i) =>
        row.display === 'card' ? (
          <InlineCard
            key={row.id}
            row={row}
            selected={selectedIndex === i}
            onSelect={() => setSelectedIndex(i)}
            onActivate={() => onActivate(i)}
          />
        ) : (
          <ListItem
            key={row.id}
            item={{ id: row.id, title: row.title, subtitle: row.subtitle, icon: row.icon, kind: 'extensionCommand' }}
            selected={selectedIndex === i}
            onSelect={() => setSelectedIndex(i)}
            onActivate={() => onActivate(i)}
          />
        ),
      )}
      <ResultList
        items={items}
        selectedIndex={selectedIndex - inlineRows.length}
        onSelectIndex={(index) => setSelectedIndex(index + inlineRows.length)}
        onActivateIndex={(index) => onActivate(index + inlineRows.length)}
        sectionLabel={query.trim() ? 'Results' : 'Suggestions'}
      />
      {actionPanelOpen && panelActions.length > 0 && (
        <ActionPanel actions={panelActions} onClose={() => setActionPanelOpen(false)} />
      )}
      <Footer
        primaryActionLabel={
          selectedIndex < inlineRows.length ? (inlineRows[selectedIndex]?.commandName ? 'Create Note' : 'Copy') : 'Open'
        }
      />
      {overlays}
    </div>
  )
}

function App() {
  return (
    <ThemeProvider>
      <Palette />
    </ThemeProvider>
  )
}

export default App
