import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { UiNode } from '@openray/protocol'
import { SearchBar } from '../components/SearchBar'
import { Footer } from '../components/Footer'
import { ActionPanel } from '../components/ActionPanel'
import { FilterSelect } from '../components/FilterSelect'
import { ChevronDownIcon } from '../components/icons'
import { BackButton } from '../components/BackButton'
import { altHorizontalDirection, altNavigationDirection, useListNavigation, useScrollIntoViewWhenSelected } from '../components/useListNavigation'
import { useAppSettings } from '../state/appSettings'
import { resolveVisual } from './resolveVisual'
import { isHoverSelectionEnabled, suppressHoverSelection } from '../components/hoverSelection'
import { useExtensionRootNode, useExtensionTree } from './registry'
import { looksLikeIconName, lookupSystemIcon } from '../components/systemIconNames'
import { useVirtualizedGrid } from './useVirtualizedGrid'
import { actionsFromSlot, findActionsSlot, matchesShortcut, parseShortcut } from './actions'
import { fuzzyScore } from './fuzzyMatch'
import { invokeExtensionCallback } from '../ipc/extensionHost'
import { openUrl } from '../ipc/window'
import type { PaletteAction } from '../state/actions'
import type { Editor } from '@tiptap/react'
import { MarkdownEditorCore } from '../components/markdown-editor/MarkdownEditorCore'
import { FormatBar } from '../components/markdown-editor/FormatBar'
import '../components/markdown-editor/markdown-editor.css'

/** Debounce for the `onSearchTextChange` round trip to the extension host
 *  (List's and Grid's search effects below) — each keystroke's own effect
 *  fired an independent, unordered `invokeExtensionCallback` round trip
 *  with no way to tell a stale response from the latest one apart once it
 *  lands, so `useControlledProp`'s "apply whatever differs from what we
 *  last saw" guard could apply an *older* echo that happened to arrive
 *  after a newer one already had — the extension's own `searchText` state
 *  visibly ping-ponged between an in-progress and the final query, which
 *  re-fired this same effect on every bounce (each application is itself
 *  a "change"), snowballing into hundreds of redundant round trips and a
 *  real, visible flash. A short debounce keeps at most one request
 *  in flight per pause in typing, matching `FileSearchList.tsx`'s own
 *  `SEARCH_DEBOUNCE_MS` convention for the identical class of problem.
 */
const SEARCH_TEXT_CALLBACK_DEBOUNCE_MS = 120

function callbackId(prop: unknown): string | null {
  if (prop && typeof prop === 'object' && '__callback' in (prop as Record<string, unknown>)) {
    return (prop as { __callback: string }).__callback
  }
  return null
}

function propString(node: UiNode, key: string): string | undefined {
  const value = node.props[key]
  return typeof value === 'string' ? value : undefined
}

function propBoolean(node: UiNode, key: string): boolean {
  return node.props[key] === true
}

/** Finds a direct child of `node` matching `type`, ignoring `__actions`/text
 * children — used for singleton slots like `List.EmptyView`/`Grid.EmptyView`
 * that can appear anywhere among a view's top-level children. */
function findChildByType(node: UiNode, nodes: Record<string, UiNode>, type: string): UiNode | undefined {
  for (const childId of node.children) {
    const child = nodes[childId]
    if (child?.type === type) return child
  }
  return undefined
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/

function isAbsolutePath(source: string): boolean {
  return source.startsWith('/') || WINDOWS_PATH.test(source)
}

/** `Detail`'s markdown can embed a local image (T28: clipboard-history's
 *  preview) via ordinary `![](path)` syntax — react-markdown otherwise
 *  hands that path straight to the browser as-is, which can't load it.
 *  Routes an absolute path through the same `convertFileSrc` every other
 *  local-file visual (`VisualContent`) already uses; anything else keeps
 *  react-markdown's own default sanitization (http(s), mailto, etc). */
function markdownUrlTransform(url: string): string {
  if (isAbsolutePath(url)) return convertFileSrc(url)
  // `file://` reaches here from the inline HTML `rehype-raw` parses —
  // `world-clock` builds one for the SVG of the current hour. react-markdown's
  // own default transform drops any protocol outside http/https/mailto/tel,
  // so without this the `src` was emptied before the sanitizer or anything
  // else got a say, and the pane showed a broken-image box.
  if (url.startsWith('file://')) return convertFileSrc(decodeURI(url.slice('file://'.length)))
  return defaultUrlTransform(url)
}


/** Renders a resolved `VisualSource` as an image (URL or absolute path), a
 * colour swatch (hex string), a first-party SVG (a `SYSTEM_ICON_NAMES`
 * key — see that map's doc comment), or a bare glyph (typically an
 * emoji) — the same three-way classification `GridCellContent` already
 * used, now shared with `List.Item`'s icon so both resolve identically. */
/**
 * Makes an inline-SVG data URI actually loadable.
 *
 * Extensions build these by interpolating markup straight into
 * `data:image/svg+xml,...` — `hacker-news` draws each story's rank that way.
 * The markup is unencoded, so the first `#` (in `fill="#DD7949"`) is read as
 * the start of a URL fragment and the image is truncated to nothing: every
 * row showed a broken-image placeholder. Re-encoding as base64 sidesteps
 * every such character at once.
 */
function normalizeSvgDataUri(source: string): string {
  const prefix = 'data:image/svg+xml,'
  if (!source.startsWith(prefix)) return source
  const payload = source.slice(prefix.length)
  let markup = payload
  try {
    // A properly percent-encoded payload decodes cleanly; raw markup
    // usually throws, in which case it is already what we want.
    markup = decodeURIComponent(payload)
  } catch {
    markup = payload
  }
  try {
    const bytes = new TextEncoder().encode(markup)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return `data:image/svg+xml;base64,${btoa(binary)}`
  } catch {
    return source
  }
}

function VisualContent({ raw, imageClassName, glyphClassName, swatchClassName }: { raw: unknown; imageClassName: string; glyphClassName: string; swatchClassName: string }) {
  const { source: rawSource, tint, mask } = resolveVisual(raw)
  // `Image.Mask` shapes the rendered image (Raycast's circle is what makes
  // avatars round). Applied as a class rather than an inline radius so the
  // two shapes stay defined next to every other visual style.
  const masked = mask ? `${imageClassName} openray-visual-mask--${mask === 'circle' ? 'circle' : 'rounded'}` : imageClassName
  // Normalized up front: an inline-SVG data URI is unusable as written by
  // most extensions (see `normalizeSvgDataUri`).
  const source = rawSource.startsWith('data:') ? normalizeSvgDataUri(rawSource) : rawSource
  if (!source) return null
  if (HEX_COLOR.test(source)) {
    return <span className={swatchClassName} style={{ background: source }} />
  }
  if (/^https?:\/\//.test(source)) {
    return <img className={masked} src={source} alt="" style={tint ? { backgroundColor: tint } : undefined} />
  }
  if (source.startsWith('data:')) {
    // A window's own self-extracted icon (e.g. X11 _NET_WM_ICON) has no
    // backing file to resolve via convertFileSrc — the backend already
    // PNG-encodes and base64s it (extensions/switch-windows, T19).
    return <img className={masked} src={source} alt="" style={tint ? { backgroundColor: tint } : undefined} />
  }
  if (isAbsolutePath(source)) {
    return <img className={masked} src={convertFileSrc(source)} alt="" style={tint ? { backgroundColor: tint } : undefined} />
  }
  const SystemIcon = lookupSystemIcon(source)
  if (SystemIcon) {
    // Wrapped, not `className={glyphClassName}` directly on the SVG:
    // that class's own width/height (sized for a text glyph) would win
    // over the `size` prop's SVG attributes and force a mismatched box.
    return (
      <span className={glyphClassName} style={tint ? { color: tint } : undefined}>
        <SystemIcon size={16} />
      </span>
    )
  }
  // An icon name we have no glyph for renders as nothing, not as its own
  // name: printing "arrow-up-circle" beside a story's score is worse than
  // showing the score alone. Emoji and other real glyphs still render.
  if (looksLikeIconName(source)) return null
  return <span className={glyphClassName}>{source}</span>
}

interface ListItemAccessory {
  text?: string | { value: string; color?: string }
  icon?: string
  date?: string
  tag?: string | { value: string; color?: string }
  tooltip?: string
}

function accessoryLabel(accessory: ListItemAccessory): string | undefined {
  if (accessory.date) {
    const parsed = new Date(accessory.date)
    return Number.isNaN(parsed.getTime()) ? accessory.date : parsed.toLocaleDateString()
  }
  if (typeof accessory.text === 'string') return accessory.text
  if (accessory.text) return accessory.text.value
  return undefined
}

function ListItemAccessories({ raw }: { raw: unknown }) {
  if (!Array.isArray(raw) || raw.length === 0) return null
  return (
    <div className="openray-list-item-accessories">
      {raw.map((accessory: ListItemAccessory, index) => {
        const tag = typeof accessory.tag === 'string' ? { value: accessory.tag } : accessory.tag
        const label = accessoryLabel(accessory)
        return (
          <span className="openray-list-item-accessory" key={index} title={accessory.tooltip}>
            {accessory.icon && <VisualContent raw={accessory.icon} imageClassName="openray-list-item-icon-image" glyphClassName="openray-accessory-glyph" swatchClassName="openray-accessory-glyph" />}
            {label && <span className="openray-accessory-text">{label}</span>}
            {tag && (
              <span className="openray-accessory-tag" style={tag.color ? { color: tag.color, borderColor: tag.color } : undefined}>
                {tag.value}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}

interface ListEntry {
  item: UiNode
  sectionTitle?: string
}

/**
 * Whether the *host* filters this List/Grid, or the extension does.
 *
 * Raycast's rule, which the `filtering` prop exists to state explicitly:
 * it defaults to false when `onSearchTextChange` is wired (the extension
 * is re-rendering its own rows in response) and true otherwise — but an
 * explicit `filtering={true}` means "notify me, and filter anyway".
 *
 * The prop used to be ignored entirely, so wiring the callback silently
 * disabled filtering: `devdocs` renders
 * `<List filtering={true} onSearchTextChange={setSearchText}>` — using the
 * text only to match an alias — and typing in it matched nothing at all.
 */
function hostShouldFilter(node: UiNode, hasSearchCallback: boolean): boolean {
  const filtering = node.props.filtering
  if (filtering === undefined || filtering === null) return !hasSearchCallback
  // `filtering` also takes `{ keepSectionOrder }`, which is still "yes".
  return filtering !== false
}

/**
 * The host's own List/Grid filtering. Fuzzy subsequence match against the
 * item's title, subtitle and `keywords`, best of them all, sorted by
 * descending score — see `fuzzyMatch.ts` for why this replaced a plain
 * `.includes()` filter that never scored or reordered results.
 *
 * `keywords` is not decoration: Raycast matches it and it is the only way
 * an item can be found by something it doesn't display. `devdocs` tags its
 * docsets with their alias (`keywords={["java"]}` on rows titled
 * "OpenJDK"), so searching "java" found nothing at all while "css" — which
 * happens to be in its own title — worked.
 */
function filterEntriesByQuery(entries: ListEntry[], searchText: string): ListEntry[] {
  if (!searchText) return entries
  const scored: { entry: ListEntry; score: number }[] = []
  for (const entry of entries) {
    const keywords = entry.item.props.keywords
    const haystacks = [propString(entry.item, 'title') ?? '', propString(entry.item, 'subtitle') ?? '']
    if (Array.isArray(keywords)) {
      for (const keyword of keywords) if (typeof keyword === 'string') haystacks.push(keyword)
    }
    let best: number | null = null
    for (const haystack of haystacks) {
      const score = fuzzyScore(haystack, searchText)
      if (score !== null && (best === null || score > best)) best = score
    }
    if (best !== null) scored.push({ entry, score: best })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.entry)
}

function collectListEntries(node: UiNode, nodes: Record<string, UiNode>): ListEntry[] {
  const entries: ListEntry[] = []
  for (const childId of node.children) {
    const child = nodes[childId]
    if (!child) continue
    if (child.type === 'List.Item') {
      entries.push({ item: child })
    } else if (child.type === 'List.Section') {
      const sectionTitle = propString(child, 'title')
      for (const grandId of child.children) {
        const grand = nodes[grandId]
        if (grand?.type === 'List.Item') entries.push({ item: grand, sectionTitle })
      }
    }
  }
  return entries
}

function ExtensionListItemRow({
  node,
  selected,
  detailed,
  onSelect,
  onActivate,
}: {
  node: UiNode
  selected: boolean
  /** Two-line row — see `List`'s `layout` prop. */
  detailed: boolean
  onSelect: () => void
  onActivate: () => void
}) {
  const title = propString(node, 'title') ?? ''
  const subtitle = propString(node, 'subtitle')
  const icon = node.props.icon
  const ref = useScrollIntoViewWhenSelected<HTMLDivElement>(selected)
  return (
    <div
      ref={ref}
      className={`openray-list-item${selected ? ' openray-list-item--selected' : ''}${detailed ? ' openray-list-item--detailed' : ''}`}
      onMouseEnter={() => {
        if (isHoverSelectionEnabled()) onSelect()
      }}
      onClick={onActivate}
    >
      {icon ? (
        <VisualContent raw={icon} imageClassName="openray-list-item-icon-image" glyphClassName="openray-list-item-icon" swatchClassName="openray-list-item-icon" />
      ) : (
        <span className="openray-list-item-icon openray-list-item-icon-fallback">{title.charAt(0).toUpperCase()}</span>
      )}
      {detailed ? (
        <span className="openray-list-item-main">
          <span className="openray-list-item-title">{title}</span>
          {subtitle && <span className="openray-list-item-subtitle">{subtitle}</span>}
        </span>
      ) : (
        <>
          <span className="openray-list-item-title">{title}</span>
          {subtitle && <span className="openray-list-item-subtitle">{subtitle}</span>}
        </>
      )}
      <ListItemAccessories raw={node.props.accessories} />
    </div>
  )
}

/** Shared by `List.EmptyView`/`Grid.EmptyView` — same title/description/icon
 * shape either way. */
function EmptyViewContent({ node }: { node: UiNode }) {
  const title = propString(node, 'title') ?? 'No results'
  const description = propString(node, 'description')
  const icon = node.props.icon
  return (
    <div className="openray-empty-view openray-empty-view--custom">
      {icon && (
        <div className="openray-empty-view-icon">
          <VisualContent raw={icon} imageClassName="openray-grid-cell-image" glyphClassName="openray-grid-cell-glyph" swatchClassName="openray-grid-cell-swatch" />
        </div>
      )}
      <span className="openray-empty-view-title">{title}</span>
      {description && <span className="openray-empty-view-description">{description}</span>}
    </div>
  )
}

/** A Raycast "controlled input" — extensions expect a value they set (e.g.
 *  clearing a composer after send, or a `List.Dropdown`'s `value`) to
 *  actually land, not just flow one-way via the paired `onChange`. Adopts
 *  an incoming prop value only when it wasn't just echoed by our own
 *  `onChange`, so a programmatic reset lands without fighting live input. */
function useControlledProp(propValue: string | undefined, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState(propValue ?? fallback)
  const lastSeen = useRef(propValue)

  useEffect(() => {
    if (propValue !== undefined && propValue !== lastSeen.current) {
      lastSeen.current = propValue
      setValue(propValue)
    }
  }, [propValue])

  const onChange = useCallback((next: string) => {
    lastSeen.current = next
    setValue(next)
  }, [])

  return [value, onChange]
}

function useControlledSearchText(node: UiNode): [string, (value: string) => void] {
  const propSearchText = typeof node.props.searchText === 'string' ? node.props.searchText : undefined
  return useControlledProp(propSearchText, '')
}

/** `List`'s `searchBarAccessory` — a `List.Dropdown` element, rendered into
 *  `SearchBar`'s `trailing` slot (T28: first consumer, clipboard-history's
 *  content-type filter), drawn by `FilterSelect` — a borderless label +
 *  chevron whose menu matches the ⌘K actions popover, not a native
 *  `<select>`. */
function ListDropdownAccessory({
  node,
  nodes,
  onValueChange,
  onOpenChange,
}: {
  node: UiNode
  nodes: Record<string, UiNode>
  /** Lets the owning List/Grid reselect its first row when the filter
   *  changes — picking a category is as much a new result set as typing a
   *  new query is, and leaving the old index selected lands the cursor
   *  somewhere arbitrary in the middle of the new one. */
  onValueChange?: (value: string) => void
  /** Raised while the menu is open, so the list/grid underneath leaves the
   *  arrow keys and ↵ to it. */
  onOpenChange?: (open: boolean) => void
}) {
  const propValue = typeof node.props.value === 'string' ? node.props.value : undefined
  const defaultValue = typeof node.props.defaultValue === 'string' ? node.props.defaultValue : ''
  const [value, setValue] = useControlledProp(propValue, defaultValue)
  const onChangeCallback = callbackId(node.props.onChange)

  const options: UiNode[] = []
  const collectOptions = (n: UiNode) => {
    for (const childId of n.children) {
      const child = nodes[childId]
      if (!child) continue
      if (child.type === 'List.Dropdown.Item') options.push(child)
      else if (child.type === 'List.Dropdown.Section') collectOptions(child)
    }
  }
  collectOptions(node)

  /**
   * Announce the initial selection to the extension exactly once.
   *
   * Raycast calls `onChange` with the dropdown's starting value — the
   * `defaultValue`, or the first item when none is given — so a command can
   * drive its first fetch off the selection. Rendering the default without
   * announcing it leaves the extension's own state unset, and a command
   * written the ordinary way (`usePromise(load, [topic], { execute: !!topic })`)
   * then shows "No results" forever while the dropdown visibly displays a
   * selection. Found running the real `hacker-news` extension in the
   * launcher, where nothing in the tree looked wrong.
   *
   * Skipped when the extension passes `value` itself: it is controlling the
   * selection, so it already knows what it is.
   */
  const announcedInitial = useRef(false)
  const initialValue = propValue ?? (defaultValue || (options[0] ? (propString(options[0], 'value') ?? '') : ''))
  useEffect(() => {
    if (announcedInitial.current || propValue !== undefined || !initialValue) return
    announcedInitial.current = true
    if (value !== initialValue) setValue(initialValue)
    if (onChangeCallback) void invokeExtensionCallback(onChangeCallback, [initialValue])
    // Fires once per mount; `value`/`setValue` are deliberately not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue, onChangeCallback, propValue])

  return (
    <FilterSelect
      label={propString(node, 'tooltip') ?? 'Filter'}
      value={value}
      onOpenChange={onOpenChange}
      options={options.map((option) => ({ value: propString(option, 'value') ?? '', label: propString(option, 'title') ?? '' }))}
      onChange={(next) => {
        setValue(next)
        onValueChange?.(next)
        if (onChangeCallback) void invokeExtensionCallback(onChangeCallback, [next])
      }}
    />
  )
}

function ExtensionList({
  node,
  nodes,
  onBack,
  title,
  icon,
  extensionId,
}: {
  node: UiNode
  nodes: Record<string, UiNode>
  onBack?: () => void
  title?: string
  icon?: string | null
  extensionId?: string
}) {
  const [searchText, setSearchText] = useControlledSearchText(node)
  const [actionPanelOpen, setActionPanelOpen] = useState(false)
  const [accessoryValue, setAccessoryValue] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const entries = useMemo(() => collectListEntries(node, nodes), [node, nodes])
  const searchCallback = callbackId(node.props.onSearchTextChange)
  const emptyView = findChildByType(node, nodes, 'List.EmptyView')
  const dropdownAccessory = findChildByType(node, nodes, 'List.Dropdown')

  const shouldFilter = hostShouldFilter(node, Boolean(searchCallback))
  const filtered = useMemo(() => {
    if (!shouldFilter) return entries
    return filterEntriesByQuery(entries, searchText)
  }, [entries, searchText, shouldFilter])

  useEffect(() => {
    if (!searchCallback) return
    const timer = setTimeout(() => void invokeExtensionCallback(searchCallback, [searchText]), SEARCH_TEXT_CALLBACK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchCallback, searchText])

  const onActivate = useCallback(
    (index: number, secondary?: boolean) => {
      const entry = filtered[index]
      if (!entry) return
      const entryActions = actionsFromSlot(findActionsSlot(entry.item, nodes), nodes)
      const action: PaletteAction | undefined = secondary ? entryActions[1] : entryActions[0]
      void action?.onAction()
    },
    [filtered, nodes],
  )

  const { selectedIndex, setSelectedIndex } = useListNavigation(
    filtered.length,
    onActivate,
    !actionPanelOpen && !dropdownOpen,
    `${searchText}\u0000${accessoryValue}`,
  )

  // Raycast's master-detail pattern: the extension keeps the selected id
  // in its own state and renders the right-hand pane from it. The prop was
  // declared but never fired, so such an extension stayed on whatever it
  // started with — `world-clock` requested the time for an empty timezone
  // on every row and got HTTP 400 back, then rendered `NaN` where the
  // clock face belonged.
  const selectionCallback = callbackId(node.props.onSelectionChange)
  const selectedItemId = filtered[selectedIndex] && propString(filtered[selectedIndex].item, 'id')
  useEffect(() => {
    if (!selectionCallback) return
    // `null` is Raycast's "nothing is selected", which is what an empty
    // list means — an item with no `id` of its own is also reported that
    // way rather than as a node id the extension has never seen.
    void invokeExtensionCallback(selectionCallback, [selectedItemId ?? null])
  }, [selectionCallback, selectedItemId])

  const actions = useMemo(() => {
    if (filtered.length === 0) return actionsFromSlot(emptyView && findActionsSlot(emptyView, nodes), nodes)
    const selected = filtered[selectedIndex]
    return actionsFromSlot(selected && findActionsSlot(selected.item, nodes), nodes)
  }, [filtered, selectedIndex, nodes, emptyView])

  // `List.Item.detail` (T28: first consumer, clipboard-history's preview
  // pane) switches the whole list into a two-column layout — matching
  // Raycast, where using `detail` on any item applies list-wide, not
  // per-item — showing the *selected* item's own detail on the right.
  const hasDetail = useMemo(() => filtered.some(({ item }) => findChildByType(item, nodes, 'Detail')), [filtered, nodes])
  const selectedDetail = useMemo(() => {
    const selected = filtered[selectedIndex]
    return selected ? findChildByType(selected.item, nodes, 'Detail') : undefined
  }, [filtered, selectedIndex, nodes])

  useEffect(() => {
    if (dropdownOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        if (filtered.length > 0 || emptyView) setActionPanelOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [filtered.length, emptyView, dropdownOpen])

  let lastSectionTitle: string | undefined
  const detailedRows = propString(node, 'layout') === 'detailed'
  const rows = (
    <div className="openray-result-list">
      {filtered.length === 0 && (emptyView ? <EmptyViewContent node={emptyView} /> : <div className="openray-empty-view">No results</div>)}
      {filtered.map((entry, index) => {
        const showHeader = entry.sectionTitle && entry.sectionTitle !== lastSectionTitle
        lastSectionTitle = entry.sectionTitle
        return (
          <div key={entry.item.id}>
            {showHeader && <div className="openray-settings-subheading">{entry.sectionTitle}</div>}
            <ExtensionListItemRow
              node={entry.item}
              selected={index === selectedIndex}
              detailed={detailedRows}
              onSelect={() => setSelectedIndex(index)}
              onActivate={() => onActivate(index)}
            />
          </div>
        )
      })}
    </div>
  )
  return (
    <div className="palette">
      <SearchBar
        value={searchText}
        onChange={setSearchText}
        placeholder="Search…"
        onBack={onBack}
        loading={propBoolean(node, 'isLoading')}
        trailing={dropdownAccessory && <ListDropdownAccessory node={dropdownAccessory} nodes={nodes} onValueChange={setAccessoryValue} onOpenChange={setDropdownOpen} />}
      />
      {hasDetail ? (
        <div className="openray-list-split">
          {rows}
          <div className="openray-list-detail-pane">{selectedDetail && <DetailBody node={selectedDetail} nodes={nodes} />}</div>
        </div>
      ) : (
        rows
      )}
      {actionPanelOpen && <ActionPanel actions={actions} onClose={() => setActionPanelOpen(false)} />}
      <Footer primaryActionLabel={actions[0]?.title} context={title} contextIcon={icon} extensionId={extensionId} />
    </div>
  )
}

function collectGridEntries(node: UiNode, nodes: Record<string, UiNode>): ListEntry[] {
  const entries: ListEntry[] = []
  for (const childId of node.children) {
    const child = nodes[childId]
    if (!child) continue
    if (child.type === 'Grid.Item') {
      entries.push({ item: child })
    } else if (child.type === 'Grid.Section') {
      const sectionTitle = propString(child, 'title')
      for (const grandId of child.children) {
        const grand = nodes[grandId]
        if (grand?.type === 'Grid.Item') entries.push({ item: grand, sectionTitle })
      }
    }
  }
  return entries
}

/**
 * A grid cell's visual. `content` is a string or `{source, tintColor}` —
 * the same shape `List.Item.icon` uses, resolved by the shared
 * `VisualContent`. Relative asset names can't be resolved here (the UI tree
 * doesn't carry the extension's assetsPath), so they fall back to a glyph
 * rather than a broken image.
 */
function GridCellContent({ node }: { node: UiNode }) {
  return <VisualContent raw={node.props.content} imageClassName="openray-grid-cell-image" glyphClassName="openray-grid-cell-glyph" swatchClassName="openray-grid-cell-swatch" />
}

function ExtensionGridCell({
  node,
  selected,
  onSelect,
  onActivate,
  measureRef,
}: {
  node: UiNode
  selected: boolean
  onSelect: () => void
  onActivate: () => void
  /** T29: attached to the windowed grid's first visible cell only, so
   *  `useVirtualizedGrid` can measure a real rendered row height. */
  measureRef?: (el: HTMLDivElement | null) => void
}) {
  const title = propString(node, 'title')
  const subtitle = propString(node, 'subtitle')
  const scrollRef = useScrollIntoViewWhenSelected<HTMLDivElement>(selected)
  return (
    <div
      ref={(el) => {
        scrollRef.current = el
        measureRef?.(el)
      }}
      className={`openray-grid-cell${selected ? ' openray-grid-cell--selected' : ''}`}
      onMouseEnter={() => {
        if (isHoverSelectionEnabled()) onSelect()
      }}
      onClick={onActivate}
    >
      <div className="openray-grid-cell-content">
        <GridCellContent node={node} />
      </div>
      {title && <span className="openray-grid-cell-title">{title}</span>}
      {subtitle && <span className="openray-grid-cell-subtitle">{subtitle}</span>}
    </div>
  )
}

function ExtensionGrid({
  node,
  nodes,
  onBack,
  title,
  icon,
  extensionId,
}: {
  node: UiNode
  nodes: Record<string, UiNode>
  onBack?: () => void
  title?: string
  icon?: string | null
  extensionId?: string
}) {
  const [searchText, setSearchText] = useControlledSearchText(node)
  const [actionPanelOpen, setActionPanelOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [accessoryValue, setAccessoryValue] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const { altJkNavigation } = useAppSettings()

  const columns = typeof node.props.columns === 'number' && node.props.columns > 0 ? node.props.columns : 5

  const entries = useMemo(() => collectGridEntries(node, nodes), [node, nodes])
  const searchCallback = callbackId(node.props.onSearchTextChange)
  const emptyView = findChildByType(node, nodes, 'Grid.EmptyView')
  const dropdownAccessory = findChildByType(node, nodes, 'List.Dropdown')

  const shouldFilter = hostShouldFilter(node, Boolean(searchCallback))
  const filtered = useMemo(() => {
    if (!shouldFilter) return entries
    return filterEntriesByQuery(entries, searchText)
  }, [entries, searchText, shouldFilter])

  // Windowing only kicks in for a flat grid (T29's actual need,
  // screenshots) — a sectioned grid (emoji's category groups, the only
  // other current `Grid` consumer, always modest in size) keeps the
  // original always-mount rendering below rather than teaching the row
  // math to skip section-header rows too.
  const hasSections = useMemo(() => filtered.some((entry) => entry.sectionTitle), [filtered])
  const { containerRef, measureFirstCell, onScroll, startIndex, endIndex, topSpacerHeight, bottomSpacerHeight, scrollIndexIntoView } =
    useVirtualizedGrid(filtered.length, columns)

  useEffect(() => {
    if (!hasSections) scrollIndexIntoView(selectedIndex)
  }, [selectedIndex, scrollIndexIntoView, hasSections])

  useEffect(() => {
    if (!searchCallback) return
    const timer = setTimeout(() => void invokeExtensionCallback(searchCallback, [searchText]), SEARCH_TEXT_CALLBACK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchCallback, searchText])

  // Reselect the top result whenever the query — or the search bar's own
  // filter dropdown — changes: same reasoning as useListNavigation's own
  // resetKey (see its doc comment), the item count alone doesn't tell you
  // the result set is entirely different, so the clamp effect below is not
  // enough on its own.
  useEffect(() => {
    setSelectedIndex(0)
  }, [searchText, accessoryValue])

  useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1))
  }, [filtered.length, selectedIndex])

  const onActivate = useCallback(
    (index: number, secondary?: boolean) => {
      const entry = filtered[index]
      if (!entry) return
      const entryActions = actionsFromSlot(findActionsSlot(entry.item, nodes), nodes)
      const action: PaletteAction | undefined = secondary ? entryActions[1] : entryActions[0]
      void action?.onAction()
    },
    [filtered, nodes],
  )

  // Raycast's master-detail pattern: the extension keeps the selected id
  // in its own state and renders the right-hand pane from it. The prop was
  // declared but never fired, so such an extension stayed on whatever it
  // started with — `world-clock` requested the time for an empty timezone
  // on every row and got HTTP 400 back, then rendered `NaN` where the
  // clock face belonged.
  const selectionCallback = callbackId(node.props.onSelectionChange)
  const selectedItemId = filtered[selectedIndex] && propString(filtered[selectedIndex].item, 'id')
  useEffect(() => {
    if (!selectionCallback) return
    // `null` is Raycast's "nothing is selected", which is what an empty
    // list means — an item with no `id` of its own is also reported that
    // way rather than as a node id the extension has never seen.
    void invokeExtensionCallback(selectionCallback, [selectedItemId ?? null])
  }, [selectionCallback, selectedItemId])

  const actions = useMemo(() => {
    if (filtered.length === 0) return actionsFromSlot(emptyView && findActionsSlot(emptyView, nodes), nodes)
    const selected = filtered[selectedIndex]
    return actionsFromSlot(selected && findActionsSlot(selected.item, nodes), nodes)
  }, [filtered, selectedIndex, nodes, emptyView])

  // 2D navigation: ←/→ step one cell, ↑/↓ step a whole row (`columns`),
  // clamped rather than wrapped so the last partial row is reachable.
  useEffect(() => {
    if (actionPanelOpen || dropdownOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        if (filtered.length > 0 || emptyView) setActionPanelOpen(true)
        return
      }
      if (filtered.length === 0) return

      const move = (delta: number) => {
        suppressHoverSelection()
        setSelectedIndex((index) => Math.min(Math.max(index + delta, 0), filtered.length - 1))
      }

      const altVertical = altJkNavigation ? altNavigationDirection(event) : null
      const altHorizontal = altJkNavigation ? altHorizontalDirection(event) : null
      if (altVertical) {
        event.preventDefault()
        move(altVertical * columns)
      } else if (altHorizontal) {
        event.preventDefault()
        move(altHorizontal)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        move(1)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        move(-1)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        move(columns)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        move(-columns)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        onActivate(selectedIndex, event.ctrlKey || event.metaKey)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [filtered.length, columns, selectedIndex, onActivate, actionPanelOpen, altJkNavigation, emptyView])

  let cells: React.ReactNode
  if (hasSections) {
    let lastSectionTitle: string | undefined
    const built: React.ReactNode[] = []
    filtered.forEach((entry, index) => {
      if (entry.sectionTitle && entry.sectionTitle !== lastSectionTitle) {
        lastSectionTitle = entry.sectionTitle
        built.push(
          <div key={`section-${entry.sectionTitle}-${index}`} className="openray-grid-section-title">
            {entry.sectionTitle}
          </div>,
        )
      }
      built.push(
        <ExtensionGridCell
          key={entry.item.id}
          node={entry.item}
          selected={index === selectedIndex}
          onSelect={() => setSelectedIndex(index)}
          onActivate={() => onActivate(index)}
        />,
      )
    })
    cells = built
  } else {
    cells = (
      <>
        {topSpacerHeight > 0 && <div style={{ gridColumn: '1 / -1', height: topSpacerHeight }} />}
        {filtered.slice(startIndex, endIndex).map((entry, offset) => {
          const index = startIndex + offset
          return (
            <ExtensionGridCell
              key={entry.item.id}
              node={entry.item}
              selected={index === selectedIndex}
              onSelect={() => setSelectedIndex(index)}
              onActivate={() => onActivate(index)}
              measureRef={offset === 0 ? measureFirstCell : undefined}
            />
          )
        })}
        {bottomSpacerHeight > 0 && <div style={{ gridColumn: '1 / -1', height: bottomSpacerHeight }} />}
      </>
    )
  }

  return (
    <div className="palette">
      <SearchBar
        value={searchText}
        onChange={setSearchText}
        placeholder={propString(node, 'searchBarPlaceholder') ?? 'Search…'}
        onBack={onBack}
        loading={propBoolean(node, 'isLoading')}
        trailing={dropdownAccessory && <ListDropdownAccessory node={dropdownAccessory} nodes={nodes} onValueChange={setAccessoryValue} onOpenChange={setDropdownOpen} />}
      />
      <div
        ref={hasSections ? undefined : containerRef}
        className="openray-grid"
        style={{ ['--openray-grid-columns' as string]: columns }}
        onScroll={hasSections ? undefined : onScroll}
      >
        {filtered.length === 0 && (emptyView ? <EmptyViewContent node={emptyView} /> : <div className="openray-empty-view">No results</div>)}
        {cells}
      </div>
      {actionPanelOpen && <ActionPanel actions={actions} onClose={() => setActionPanelOpen(false)} />}
      <Footer primaryActionLabel={actions[0]?.title} context={title} contextIcon={icon} extensionId={extensionId} />
    </div>
  )
}

function DetailMetadataTagListRow({ node, nodes }: { node: UiNode; nodes: Record<string, UiNode> }) {
  const title = propString(node, 'title')
  return (
    <dl>
      <dt>{title}</dt>
      <dd className="openray-tag-list">
        {node.children.map((childId) => {
          const tag = nodes[childId]
          if (!tag || tag.type !== 'Detail.Metadata.TagList.Item') return null
          const text = propString(tag, 'text')
          const color = propString(tag, 'color')
          const onAction = callbackId(tag.props.onAction)
          const Tag = onAction ? 'button' : 'span'
          return (
            <Tag
              key={tag.id}
              type={onAction ? 'button' : undefined}
              className="openray-tag"
              style={color ? { color, borderColor: color } : undefined}
              onClick={onAction ? () => void invokeExtensionCallback(onAction, []) : undefined}
            >
              {text}
            </Tag>
          )
        })}
      </dd>
    </dl>
  )
}

function ExtensionDetailMetadata({ node, nodes }: { node: UiNode; nodes: Record<string, UiNode> }) {
  return (
    <div className="openray-detail-fields">
      {node.children.map((childId) => {
        const child = nodes[childId]
        if (!child) return null
        if (child.type === 'Detail.Metadata.Separator') return <hr key={child.id} />
        if (child.type === 'Detail.Metadata.TagList') return <DetailMetadataTagListRow key={child.id} node={child} nodes={nodes} />
        if (child.type === 'Detail.Metadata.Link') {
          const title = propString(child, 'title')
          const target = propString(child, 'target') ?? ''
          const text = propString(child, 'text') ?? target
          return (
            <dl key={child.id}>
              <dt>{title}</dt>
              <dd>
                <a
                  className="openray-metadata-link"
                  href={target}
                  onClick={(event) => {
                    event.preventDefault()
                    void openUrl(target)
                  }}
                >
                  {text}
                </a>
              </dd>
            </dl>
          )
        }
        const title = propString(child, 'title')
        const text = propString(child, 'text')
        // `Detail.Metadata.Label`'s own `icon` (already in the shim's
        // props) — a hex string renders as a swatch, which is how a
        // clipboard colour entry shows the colour itself next to its
        // notation.
        const labelIcon = child.props.icon
        return (
          <dl key={child.id}>
            <dt>{title}</dt>
            <dd>
              {labelIcon && (
                <VisualContent
                  raw={labelIcon}
                  imageClassName="openray-detail-field-image"
                  glyphClassName="openray-detail-field-glyph"
                  swatchClassName="openray-detail-field-swatch"
                />
              )}
              {text}
            </dd>
          </dl>
        )
      })}
    </div>
  )
}

/** A `Detail` node's markdown+metadata content, with no chrome of its own
 *  (no `ActionPanel`/`Footer`) — shared between `ExtensionDetail` (a
 *  full-window `Detail` view) and `ExtensionList`'s split-pane
 *  `List.Item.detail` (T28), which reuses the exact same node type. */
/**
 * Raycast's `Detail.markdown` renders inline HTML, and extensions rely on
 * it — `world-clock` draws its clock face as a bare
 * `<img src="file://…/9.svg" height="180" />`, which react-markdown
 * escapes by default, so the tag was printed as literal text across the
 * detail pane.
 *
 * `rehype-raw` parses it; `rehype-sanitize` is what makes that safe to do.
 * Markdown here is not always the extension's own text — plenty of
 * commands render a fetched README or API response — so raw HTML from the
 * network would otherwise land in the webview verbatim. The schema is
 * rehype's default (no script, no event handlers) plus the width/height
 * attributes an `<img>` needs to be laid out at all.
 */
const MARKDOWN_HTML_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'],
  },
  // `file:` for an extension's own bundled assets, which is the whole
  // reason these tags are being written.
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'file'],
  },
}

function DetailBody({ node, nodes }: { node: UiNode; nodes: Record<string, UiNode> }) {
  const markdown = propString(node, 'markdown') ?? ''
  const metadataNode = node.children.map((id) => nodes[id]).find((n) => n?.type === 'Detail.Metadata')
  // The rendered content scrolls; the metadata block stays put beneath it
  // rather than scrolling away with long content — Raycast's own detail
  // pane splits the same way.
  return (
    <>
      <div className="openray-detail-markdown">
        <Markdown
          urlTransform={markdownUrlTransform}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, MARKDOWN_HTML_SCHEMA]]}
        >
          {markdown}
        </Markdown>
      </div>
      {metadataNode && (
        <div className="openray-detail-info">
          <h4 className="openray-detail-info-heading">Information</h4>
          <ExtensionDetailMetadata node={metadataNode} nodes={nodes} />
        </div>
      )}
    </>
  )
}

function ExtensionDetail({
  node,
  nodes,
  title,
  icon,
  onBack,
  extensionId,
}: {
  node: UiNode
  nodes: Record<string, UiNode>
  title?: string
  icon?: string | null
  extensionId?: string
  /** Present when this view was pushed onto a navigation stack — a Detail
   *  reached via `Action.Push` needs the same way back a Form does. */
  onBack?: () => void
}) {
  const actionsSlot = findActionsSlot(node, nodes)
  const actions = actionsFromSlot(actionsSlot, nodes)
  const [actionPanelOpen, setActionPanelOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        setActionPanelOpen((open) => !open)
      } else if (event.key === 'Enter' && actions[0]) {
        event.preventDefault()
        void actions[0].onAction()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actions])

  return (
    <div className="palette">
      {/* Same top bar a Form gets, and for the same reason: a Detail has no
          search field, but a pushed one still needs the way back. The view's
          name is read off the footer, not repeated up here. */}
      {onBack && (
        <div className="openray-form-header">
          <BackButton onClick={onBack} />
          {propBoolean(node, 'isLoading') && <span className="openray-toast-spinner" aria-label="Loading" />}
        </div>
      )}
      {/* `openray-detail-page` marks the full-page case. `DetailBody` gives
          the markdown its own scroll pane and pins the metadata beneath —
          correct inside a List, where the pane has a fixed height, but here
          the outer container already scrolls, so the inner one collapses to
          a sliver and clips tall content (a screenshot showed ~75px of 260). */}
      <div className="openray-settings-content openray-detail-page" style={{ overflowY: 'auto', flex: 1 }}>
        <DetailBody node={node} nodes={nodes} />
      </div>
      {actionPanelOpen && <ActionPanel actions={actions} onClose={() => setActionPanelOpen(false)} />}
      <Footer primaryActionLabel={actions[0]?.title} context={title} contextIcon={icon} extensionId={extensionId} />
    </div>
  )
}

/**
 * T25: the one node type backed by a real, stateful host widget instead of
 * a plain serialized-prop tree — see `MarkdownEditorCore`'s own doc
 * comment for the `documentId`/`value`/`onChange` contract this adapts
 * `node.props` into. `onChange` fires via the same
 * `invokeExtensionCallback` round trip every other callback prop in this
 * file already uses (e.g. `Form.TextArea`'s `onChange`, below) — already
 * debounced host-side by `MarkdownEditorCore` itself, so this never fires
 * per-keystroke.
 */
function ExtensionMarkdownEditor({ node, nodes }: { node: UiNode; nodes: Record<string, UiNode> }) {
  const rawId = node.props.id
  const documentId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : node.id
  const value = propString(node, 'value') ?? ''
  const placeholder = propString(node, 'placeholder')
  const onChangeId = callbackId(node.props.onChange)
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null)
  const actionsSlot = findActionsSlot(node, nodes)
  const actions = actionsFromSlot(actionsSlot, nodes)
  const [actionPanelOpen, setActionPanelOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        setActionPanelOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="palette" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <MarkdownEditorCore
          documentId={documentId}
          value={value}
          placeholder={placeholder}
          onChange={(markdown) => {
            if (onChangeId) void invokeExtensionCallback(onChangeId, [markdown])
          }}
          onEditorReady={setEditorInstance}
        />
      </div>
      {editorInstance && <FormatBar editor={editorInstance} />}
      {actionPanelOpen && actions.length > 0 && <ActionPanel actions={actions} onClose={() => setActionPanelOpen(false)} />}
    </div>
  )
}

/** The value of a dropdown's first option — what it displays, and
 *  therefore what submitting it untouched means. */
function firstDropdownValue(field: UiNode, nodes: Record<string, UiNode>): string | undefined {
  for (const childId of field.children) {
    const child = nodes[childId]
    if (!child) continue
    if (child.type === 'Form.Dropdown.Item') return propString(child, 'value') ?? ''
    if (child.type === 'Form.Dropdown.Section') {
      const nested = firstDropdownValue(child, nodes)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function ExtensionForm({
  node,
  nodes,
  onBack,
  title,
  icon,
  extensionId,
}: {
  node: UiNode
  nodes: Record<string, UiNode>
  onBack?: () => void
  title?: string
  icon?: string | null
  extensionId?: string
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const actionsSlot = findActionsSlot(node, nodes)
  const [actionPanelOpen, setActionPanelOpen] = useState(false)

  // `values` reaches the keydown listener and the panel's callbacks
  // through a ref, so neither has to be rebuilt on every keystroke.
  const valuesRef = useRef(values)
  valuesRef.current = values

  /**
   * Every field's *effective* value, not only the ones that were edited.
   *
   * A field renders `value` / `defaultValue` when the user hasn't typed
   * anything, but only an edit used to put a value in this map — so
   * submitting a form without touching a prefilled field sent nothing for
   * it. `Create Extension` showed the symptom: its Location field is
   * prefilled, and submitting straight away failed with "Enter an
   * absolute folder path" against a box that visibly held one.
   */
  const collectValues = useCallback((): Record<string, string | boolean> => {
    const collected: Record<string, string | boolean> = {}
    for (const childId of node.children) {
      const field = nodes[childId]
      if (!field?.type.startsWith('Form.')) continue
      if (field.type === 'Form.Separator' || field.type === 'Form.Description') continue
      const fieldId = propString(field, 'id') ?? field.id
      const declared = field.props.value ?? field.props.defaultValue
      if (typeof declared === 'string' || typeof declared === 'boolean') {
        collected[fieldId] = declared
      } else if (field.type === 'Form.Checkbox') {
        collected[fieldId] = false
      } else if (field.type === 'Form.FilePicker' || field.type === 'Form.TagPicker') {
        // Both are array-valued; an untouched one submits an empty array
        // rather than the empty string a text field would.
        collected[fieldId] = [] as unknown as string
      } else if (field.type === 'Form.DatePicker') {
        // Raycast's value is `Date | null`; tagged so the shim can tell a
        // never-picked date from an empty string.
        collected[fieldId] = { __date: null } as unknown as string
      } else if (field.type === 'Form.Dropdown') {
        // A dropdown with no declared value shows its first option, so
        // that is what submitting it means.
        collected[fieldId] = firstDropdownValue(field, nodes) ?? ''
      } else {
        collected[fieldId] = ''
      }
    }
    return { ...collected, ...valuesRef.current }
  }, [node.children, nodes])

  const submitValues = useCallback(
    (submitNode: UiNode) => {
      const id = callbackId(submitNode.props.onSubmit)
      if (id) void invokeExtensionCallback(id, [collectValues()])
    },
    [collectValues],
  )

  /** Every `Action.SubmitForm` in the panel, in the order it was declared.
   *  Raycast forms routinely offer several ("Create", "Create and Open
   *  Folder", …); only the first used to be reachable. */
  const submitNodes = useMemo(() => {
    const found: UiNode[] = []
    function walk(id: string): void {
      const n = nodes[id]
      if (!n) return
      if (n.props.__variant === 'submit-form') found.push(n)
      for (const childId of n.children) walk(childId)
    }
    if (actionsSlot) walk(actionsSlot.id)
    return found
  }, [actionsSlot, nodes])

  // `Action.SubmitForm`'s `onSubmit` takes the collected values, which
  // `actionsFromSlot` — built for the generic `onAction` shape — has no
  // way to supply. Picking one of those from the ⌘K menu did nothing at
  // all; rebind them here, where the values live.
  const actions = useMemo(
    () =>
      actionsFromSlot(actionsSlot, nodes).map((action) => {
        const actionNode = nodes[action.id]
        if (actionNode?.props.__variant !== 'submit-form') return action
        return { ...action, onAction: () => submitValues(actionNode) }
      }),
    [actionsSlot, nodes, submitValues],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        setActionPanelOpen((open) => !open)
        return
      }
      if (event.key !== 'Enter') return

      // A submit action that declares its own shortcut owns that exact
      // combination — otherwise the menu would advertise ⌘⇧↵ next to an
      // action that never fires.
      const explicit = submitNodes.find((submitNode) => {
        const shortcut = parseShortcut(submitNode.props.shortcut)
        return shortcut ? matchesShortcut(event, shortcut) : false
      })
      if (explicit) {
        event.preventDefault()
        submitValues(explicit)
        return
      }

      // Plain ⌘↵ stays the primary action, as everywhere else in the app.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && submitNodes[0]) {
        event.preventDefault()
        submitValues(submitNodes[0])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [submitNodes, submitValues])

  return (
    <div className="palette">
      {/* A form has no search field, but it does have the same top bar a
          List/Grid sub-view gets: the way back. The view's name is read off
          the footer, not repeated up here. */}
      <div className="openray-form-header">
        {onBack && <BackButton onClick={onBack} />}
        {propBoolean(node, 'isLoading') && <span className="openray-toast-spinner" aria-label="Loading" />}
      </div>
      <div className="openray-form-scroll">
        {/* One grid for the whole form — right-aligned labels in a fixed
            column with every control starting at the same x, the same
            vocabulary Settings' own panes use. Each field contributes two
            grid children (label, control), so a long label can never push
            its own control out of line with the others'. */}
        <div className="openray-extension-form">
          {node.children.map((id) => {
            const field = nodes[id]
            if (!field || !field.type.startsWith('Form.')) return null
            return <FormField key={field.id} field={field} nodes={nodes} values={values} setValues={setValues} />
          })}
        </div>
      </div>
      {actionPanelOpen && <ActionPanel actions={actions} onClose={() => setActionPanelOpen(false)} />}
      <Footer primaryActionLabel={actions[0]?.title ?? 'Submit'} primaryActionNeedsCmd context={title} contextIcon={icon} extensionId={extensionId} />
    </div>
  )
}

/** One `Form.*` child: its label in the grid's label column and its control
 *  in the value column, plus the `info`/`error` lines underneath. */
function FormField({
  field,
  nodes,
  values,
  setValues,
}: {
  field: UiNode
  nodes: Record<string, UiNode>
  values: Record<string, string | boolean>
  setValues: (update: (current: Record<string, string | boolean>) => Record<string, string | boolean>) => void
}) {
  if (field.type === 'Form.Separator') {
    return <hr className="openray-extension-form-separator" />
  }

  if (field.type === 'Form.Unsupported') {
    // A form item this shim doesn't implement. Shown rather than dropped:
    // the field is missing either way, and a silent gap reads as a bug in
    // the extension rather than a gap in ours.
    return (
      <p className="openray-extension-form-description">
        <strong>{propString(field, 'title') ?? propString(field, 'name')}</strong>
        {' — this form field isn’t supported yet.'}
      </p>
    )
  }

  if (field.type === 'Form.Description') {
    // Spans both columns: it's prose about the form, not a field of it.
    return (
      <p className="openray-extension-form-description">
        {propString(field, 'title') && <strong>{propString(field, 'title')}: </strong>}
        {propString(field, 'text')}
      </p>
    )
  }

  const fieldId = propString(field, 'id') ?? field.id
  const label = propString(field, 'title')
  const info = propString(field, 'info')
  const error = propString(field, 'error')
  const controlId = `form-field-${field.id}`
  const autoFocus = propBoolean(field, 'autoFocus')
  // `useForm().focus(id)` — and its focus-the-first-invalid-field on a
  // failed submit — arrive as a bumped nonce on this field rather than as
  // a new protocol message, so the existing commit path carries them.
  // React's `autoFocus` can't serve: it only applies at mount, so a second
  // request for an already-mounted field would do nothing.
  const focusRequest = field.props.focusRequest
  const controlRef = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null)
  useEffect(() => {
    if (focusRequest === undefined || focusRequest === null) return
    controlRef.current?.focus()
  }, [focusRequest])

  const fireOnChange = (value: unknown) => {
    const callback = callbackId(field.props.onChange)
    if (callback) void invokeExtensionCallback(callback, [value])
  }
  const set = (value: string | boolean) => {
    setValues((current) => ({ ...current, [fieldId]: value }))
    fireOnChange(value)
  }

  // Local edits win; otherwise a `value` the extension controls, then its
  // `defaultValue`.
  const textValue =
    (values[fieldId] as string | undefined) ?? propString(field, 'value') ?? (field.props.defaultValue as string | undefined) ?? ''

  let control: ReactNode
  // A textarea is taller than one row, so its label sits at the top of the
  // box rather than centred against the whole of it.
  let labelAtTop = false

  if (field.type === 'Form.Checkbox') {
    const checked = Boolean(values[fieldId] ?? field.props.value ?? field.props.defaultValue ?? false)
    control = (
      <label className="openray-extension-form-checkbox">
        <input ref={controlRef} id={controlId} type="checkbox" checked={checked} autoFocus={autoFocus} onChange={(event) => set(event.target.checked)} />
        {propString(field, 'label')}
      </label>
    )
  } else if (field.type === 'Form.TextArea') {
    labelAtTop = true
    control = (
      <textarea
        ref={controlRef}
        id={controlId}
        className="openray-extension-form-textarea"
        value={textValue}
        placeholder={propString(field, 'placeholder')}
        autoFocus={autoFocus}
        onChange={(event) => set(event.target.value)}
      />
    )
  } else if (field.type === 'Form.FilePicker') {
    // Raycast's value here is always an array of paths, even for a single
    // selection, so an extension indexing `values.folder[0]` works.
    const selected = Array.isArray(values[fieldId])
      ? (values[fieldId] as unknown as string[])
      : Array.isArray(field.props.value)
        ? (field.props.value as string[])
        : Array.isArray(field.props.defaultValue)
          ? (field.props.defaultValue as string[])
          : []
    const chooseDirectories = propBoolean(field, 'canChooseDirectories')
    const chooseFiles = field.props.canChooseFiles !== false
    const multiple = field.props.allowMultipleSelection !== false
    const choose = async () => {
      // The same native dialog Settings' folder pickers use.
      const picked = await openDialog({
        // A picker that can only take directories asks for one; anything
        // else asks for files, since the dialog can't offer both at once.
        directory: chooseDirectories && !chooseFiles,
        multiple,
      })
      if (picked === null) return
      const paths = Array.isArray(picked) ? picked : [picked]
      set(paths as unknown as string)
    }
    control = (
      <div className="openray-extension-form-filepicker">
        <input
          ref={controlRef}
          id={controlId}
          className="openray-extension-form-input"
          type="text"
          readOnly
          value={selected.join(', ')}
          placeholder={propString(field, 'placeholder') ?? (chooseDirectories ? 'No folder selected' : 'No file selected')}
          onClick={() => void choose()}
        />
        <button type="button" onClick={() => void choose()}>
          Choose…
        </button>
      </div>
    )
  } else if (field.type === 'Form.DatePicker') {
    // `datetime-local` wants `YYYY-MM-DDTHH:mm`, `date` wants the first
    // ten characters of the same ISO string.
    const withTime = propString(field, 'type') !== 'Date'
    const held = values[fieldId]
    const iso =
      held && typeof held === 'object' && '__date' in (held as object)
        ? ((held as { __date: string | null }).__date ?? '')
        : (propString(field, 'value') ?? (field.props.defaultValue as string | undefined) ?? '')
    const shown = iso ? (withTime ? iso.slice(0, 16) : iso.slice(0, 10)) : ''
    control = (
      <input
        ref={controlRef}
        id={controlId}
        className="openray-extension-form-input"
        type={withTime ? 'datetime-local' : 'date'}
        value={shown}
        autoFocus={autoFocus}
        onChange={(event) => {
          // Back to a full ISO string, which is what the shim turns into
          // a `Date` for the extension.
          // Tagged rather than a bare string: `Form.DatePicker`'s value is
          // a `Date` on the extension's side, and props cross as JSON. The
          // shim unwraps `{__date}` back into a Date before `onSubmit` sees
          // it — a bare ISO string would arrive as a string and break
          // `values.when.getTime()`.
          const raw = event.target.value
          set({ __date: raw ? new Date(raw).toISOString() : null } as unknown as string)
        }}
      />
    )
  } else if (field.type === 'Form.TagPicker') {
    const options: UiNode[] = []
    for (const childId of field.children) {
      const child = nodes[childId]
      if (child?.type === 'Form.TagPicker.Item') options.push(child)
    }
    const selected = Array.isArray(values[fieldId])
      ? (values[fieldId] as unknown as string[])
      : Array.isArray(field.props.defaultValue)
        ? (field.props.defaultValue as string[])
        : []
    control = (
      <div className="openray-extension-form-tags">
        {options.map((option) => {
          const optionValue = propString(option, 'value') ?? ''
          const active = selected.includes(optionValue)
          return (
            <button
              key={option.id}
              type="button"
              className={`openray-extension-form-tag${active ? ' openray-extension-form-tag--active' : ''}`}
              onClick={() => {
                const next = active ? selected.filter((v) => v !== optionValue) : [...selected, optionValue]
                set(next as unknown as string)
              }}
            >
              {propString(option, 'title') ?? optionValue}
            </button>
          )
        })}
      </div>
    )
  } else if (field.type === 'Form.Dropdown') {
    const options: UiNode[] = []
    const collectOptions = (n: UiNode) => {
      for (const childId of n.children) {
        const child = nodes[childId]
        if (!child) continue
        if (child.type === 'Form.Dropdown.Item') options.push(child)
        else if (child.type === 'Form.Dropdown.Section') collectOptions(child)
      }
    }
    collectOptions(field)
    control = (
      <div className="openray-extension-form-select">
        <select ref={controlRef} id={controlId} value={textValue} autoFocus={autoFocus} onChange={(event) => set(event.target.value)}>
          {options.map((option) => (
            <option key={option.id} value={propString(option, 'value') ?? ''}>
              {propString(option, 'title')}
            </option>
          ))}
        </select>
        <ChevronDownIcon size={13} className="openray-extension-form-select-chevron" />
      </div>
    )
  } else {
    control = (
      <input
        ref={controlRef}
        id={controlId}
        className="openray-extension-form-input"
        type={field.type === 'Form.PasswordField' ? 'password' : 'text'}
        value={textValue}
        placeholder={propString(field, 'placeholder')}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(event) => set(event.target.value)}
      />
    )
  }

  return (
    <>
      <label className={`openray-extension-form-label${labelAtTop || info || error ? ' openray-extension-form-label--top' : ''}`} htmlFor={controlId}>
        {label}
      </label>
      <div className="openray-extension-form-control">
        {control}
        {info && <span className="openray-extension-form-hint">{info}</span>}
        {error && <span className="openray-extension-form-error">{error}</span>}
      </div>
    </>
  )
}

export function ExtensionView({
  onBack,
  title,
  icon,
  extensionId,
}: {
  onBack?: () => void
  title?: string
  icon?: string | null
  extensionId?: string
} = {}) {
  const root = useExtensionRootNode()
  const { nodes } = useExtensionTree()

  if (!root) {
    return (
      <div className="palette">
        <div className="openray-empty-view">Loading…</div>
      </div>
    )
  }

  // Keyed by the resolved root node's own id, not just its `type` — two
  // different pushed views of the same type (T22's language picker
  // pushed from a List onto another List is the first thing in this
  // codebase to actually do that) would otherwise reuse the exact same
  // `ExtensionList` component instance across the navigation, since
  // React only remounts on a type or key change, not a props change.
  // Found live: navigating from one List to another left the *previous*
  // List's local `searchText` state (and selection) in place, so the new
  // view opened already "filtered" by whatever was typed into the one it
  // replaced. Every render/`ui.commit` of the *same* logical mounted view
  // reuses the same node id (only a genuinely new pushed element gets a
  // fresh one — see `useExtensionRootNode`'s doc comment), so ordinary
  // in-place updates still correctly preserve state as before.
  switch (root.type) {
    case 'List':
      return <ExtensionList key={root.id} node={root} nodes={nodes} onBack={onBack} title={title} icon={icon} extensionId={extensionId} />
    case 'Grid':
      return <ExtensionGrid key={root.id} node={root} nodes={nodes} onBack={onBack} title={title} icon={icon} extensionId={extensionId} />
    case 'Detail':
      return <ExtensionDetail key={root.id} node={root} nodes={nodes} title={title} icon={icon} onBack={onBack} extensionId={extensionId} />
    case 'Form':
      return <ExtensionForm key={root.id} node={root} nodes={nodes} onBack={onBack} title={title} icon={icon} extensionId={extensionId} />
    case 'MarkdownEditor':
      return <ExtensionMarkdownEditor key={root.id} node={root} nodes={nodes} />
    default:
      return (
        <div className="palette">
          <div className="openray-empty-view">Unsupported view: {root.type}</div>
        </div>
      )
  }
}
