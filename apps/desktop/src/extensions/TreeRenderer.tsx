import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import type { UiNode } from '@openray/protocol'
import { SearchBar } from '../components/SearchBar'
import { Footer } from '../components/Footer'
import { ActionPanel } from '../components/ActionPanel'
import { altHorizontalDirection, altNavigationDirection, useListNavigation, useScrollIntoViewWhenSelected } from '../components/useListNavigation'
import { useAppSettings } from '../state/appSettings'
import { isHoverSelectionEnabled, suppressHoverSelection } from '../components/hoverSelection'
import { useExtensionRootNode, useExtensionTree } from './registry'
import { SYSTEM_ICON_NAMES } from '../components/systemIconNames'
import { useVirtualizedGrid } from './useVirtualizedGrid'
import { actionsFromSlot, findActionsSlot } from './actions'
import { fuzzyScore } from './fuzzyMatch'
import { invokeExtensionCallback } from '../ipc/extensionHost'
import { openUrl } from '../ipc/window'
import type { PaletteAction } from '../state/actions'
import type { Editor } from '@tiptap/react'
import { MarkdownEditorCore } from '../components/markdown-editor/MarkdownEditorCore'
import { FormatBar } from '../components/markdown-editor/FormatBar'
import '../components/markdown-editor/markdown-editor.css'

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
  return isAbsolutePath(url) ? convertFileSrc(url) : defaultUrlTransform(url)
}

interface VisualSource {
  source: string
  tint?: string
}

/** `List.Item.icon` and `Grid.Item.content` share this exact shape — a bare
 * string (emoji, hex swatch, URL, absolute path) or `{source, tintColor}`. */
function resolveVisual(raw: unknown): VisualSource {
  if (typeof raw === 'string') return { source: raw }
  if (raw && typeof raw === 'object') {
    const obj = raw as { source?: string; tintColor?: string }
    return { source: obj.source ?? '', tint: obj.tintColor }
  }
  return { source: '' }
}

/** Renders a resolved `VisualSource` as an image (URL or absolute path), a
 * colour swatch (hex string), a first-party SVG (a `SYSTEM_ICON_NAMES`
 * key — see that map's doc comment), or a bare glyph (typically an
 * emoji) — the same three-way classification `GridCellContent` already
 * used, now shared with `List.Item`'s icon so both resolve identically. */
function VisualContent({ raw, imageClassName, glyphClassName, swatchClassName }: { raw: unknown; imageClassName: string; glyphClassName: string; swatchClassName: string }) {
  const { source, tint } = resolveVisual(raw)
  if (!source) return null
  if (HEX_COLOR.test(source)) {
    return <span className={swatchClassName} style={{ background: source }} />
  }
  if (/^https?:\/\//.test(source)) {
    return <img className={imageClassName} src={source} alt="" style={tint ? { backgroundColor: tint } : undefined} />
  }
  if (source.startsWith('data:')) {
    // A window's own self-extracted icon (e.g. X11 _NET_WM_ICON) has no
    // backing file to resolve via convertFileSrc — the backend already
    // PNG-encodes and base64s it (extensions/switch-windows, T19).
    return <img className={imageClassName} src={source} alt="" style={tint ? { backgroundColor: tint } : undefined} />
  }
  if (isAbsolutePath(source)) {
    return <img className={imageClassName} src={convertFileSrc(source)} alt="" style={tint ? { backgroundColor: tint } : undefined} />
  }
  const SystemIcon = SYSTEM_ICON_NAMES[source]
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

/** The host's own default List/Grid filtering — what an extension gets for
 *  free when it doesn't wire `onSearchTextChange` and filter itself. Fuzzy
 *  subsequence match against title/subtitle (best of the two), sorted by
 *  descending score — see `fuzzyMatch.ts` for why this replaced a plain
 *  `.includes()` filter that never scored or reordered results. */
function filterEntriesByQuery(entries: ListEntry[], searchText: string): ListEntry[] {
  if (!searchText) return entries
  const scored: { entry: ListEntry; score: number }[] = []
  for (const entry of entries) {
    const title = propString(entry.item, 'title') ?? ''
    const subtitle = propString(entry.item, 'subtitle') ?? ''
    const titleScore = fuzzyScore(title, searchText)
    const subtitleScore = fuzzyScore(subtitle, searchText)
    const best = titleScore === null ? subtitleScore : subtitleScore === null ? titleScore : Math.max(titleScore, subtitleScore)
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

function ExtensionListItemRow({ node, selected, onSelect, onActivate }: { node: UiNode; selected: boolean; onSelect: () => void; onActivate: () => void }) {
  const title = propString(node, 'title') ?? ''
  const subtitle = propString(node, 'subtitle')
  const icon = node.props.icon
  const ref = useScrollIntoViewWhenSelected<HTMLDivElement>(selected)
  return (
    <div
      ref={ref}
      className={`openray-list-item${selected ? ' openray-list-item--selected' : ''}`}
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
      <span className="openray-list-item-title">{title}</span>
      {subtitle && <span className="openray-list-item-subtitle">{subtitle}</span>}
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
 *  content-type filter). */
function ListDropdownAccessory({ node, nodes }: { node: UiNode; nodes: Record<string, UiNode> }) {
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

  return (
    <select
      className="openray-searchbar-dropdown"
      value={value}
      title={propString(node, 'tooltip')}
      onChange={(event) => {
        setValue(event.target.value)
        if (onChangeCallback) void invokeExtensionCallback(onChangeCallback, [event.target.value])
      }}
    >
      {options.map((option) => (
        <option key={option.id} value={propString(option, 'value') ?? ''}>
          {propString(option, 'title')}
        </option>
      ))}
    </select>
  )
}

function ExtensionList({ node, nodes, onBack }: { node: UiNode; nodes: Record<string, UiNode>; onBack?: () => void }) {
  const [searchText, setSearchText] = useControlledSearchText(node)
  const [actionPanelOpen, setActionPanelOpen] = useState(false)

  const entries = useMemo(() => collectListEntries(node, nodes), [node, nodes])
  const searchCallback = callbackId(node.props.onSearchTextChange)
  const emptyView = findChildByType(node, nodes, 'List.EmptyView')
  const dropdownAccessory = findChildByType(node, nodes, 'List.Dropdown')

  // If the extension wired onSearchTextChange, it's re-rendering `entries`
  // itself in response — trust it and skip local filtering. Otherwise fall
  // back to the host's own default fuzzy title/subtitle filtering
  // (filterEntriesByQuery, above).
  const filtered = useMemo(() => {
    if (searchCallback) return entries
    return filterEntriesByQuery(entries, searchText)
  }, [entries, searchText, searchCallback])

  useEffect(() => {
    if (searchCallback) void invokeExtensionCallback(searchCallback, [searchText])
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

  const { selectedIndex, setSelectedIndex } = useListNavigation(filtered.length, onActivate, !actionPanelOpen, searchText)

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        if (filtered.length > 0 || emptyView) setActionPanelOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [filtered.length, emptyView])

  let lastSectionTitle: string | undefined
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
        title={propString(node, 'navigationTitle')}
        loading={propBoolean(node, 'isLoading')}
        trailing={dropdownAccessory && <ListDropdownAccessory node={dropdownAccessory} nodes={nodes} />}
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
      <Footer />
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

function ExtensionGrid({ node, nodes, onBack }: { node: UiNode; nodes: Record<string, UiNode>; onBack?: () => void }) {
  const [searchText, setSearchText] = useControlledSearchText(node)
  const [actionPanelOpen, setActionPanelOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const { altJkNavigation } = useAppSettings()

  const columns = typeof node.props.columns === 'number' && node.props.columns > 0 ? node.props.columns : 5

  const entries = useMemo(() => collectGridEntries(node, nodes), [node, nodes])
  const searchCallback = callbackId(node.props.onSearchTextChange)
  const emptyView = findChildByType(node, nodes, 'Grid.EmptyView')
  const dropdownAccessory = findChildByType(node, nodes, 'List.Dropdown')

  const filtered = useMemo(() => {
    if (searchCallback) return entries
    return filterEntriesByQuery(entries, searchText)
  }, [entries, searchText, searchCallback])

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
    if (searchCallback) void invokeExtensionCallback(searchCallback, [searchText])
  }, [searchCallback, searchText])

  // Reselect the top result whenever the query changes — same reasoning
  // as useListNavigation's own resetKey (see its doc comment): the item
  // count alone doesn't tell you the result set is entirely different,
  // so the clamp effect below is not enough on its own.
  useEffect(() => {
    setSelectedIndex(0)
  }, [searchText])

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

  const actions = useMemo(() => {
    if (filtered.length === 0) return actionsFromSlot(emptyView && findActionsSlot(emptyView, nodes), nodes)
    const selected = filtered[selectedIndex]
    return actionsFromSlot(selected && findActionsSlot(selected.item, nodes), nodes)
  }, [filtered, selectedIndex, nodes, emptyView])

  // 2D navigation: ←/→ step one cell, ↑/↓ step a whole row (`columns`),
  // clamped rather than wrapped so the last partial row is reachable.
  useEffect(() => {
    if (actionPanelOpen) return

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
        title={propString(node, 'navigationTitle')}
        loading={propBoolean(node, 'isLoading')}
        trailing={dropdownAccessory && <ListDropdownAccessory node={dropdownAccessory} nodes={nodes} />}
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
      <Footer />
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
    <div className="openray-settings-fields">
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
        return (
          <dl key={child.id}>
            <dt>{title}</dt>
            <dd>{text}</dd>
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
function DetailBody({ node, nodes }: { node: UiNode; nodes: Record<string, UiNode> }) {
  const markdown = propString(node, 'markdown') ?? ''
  const metadataNode = node.children.map((id) => nodes[id]).find((n) => n?.type === 'Detail.Metadata')
  return (
    <>
      <Markdown urlTransform={markdownUrlTransform}>{markdown}</Markdown>
      {metadataNode && <ExtensionDetailMetadata node={metadataNode} nodes={nodes} />}
    </>
  )
}

function ExtensionDetail({ node, nodes }: { node: UiNode; nodes: Record<string, UiNode> }) {
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
      <div className="openray-settings-content" style={{ overflowY: 'auto', flex: 1 }}>
        <DetailBody node={node} nodes={nodes} />
      </div>
      {actionPanelOpen && <ActionPanel actions={actions} onClose={() => setActionPanelOpen(false)} />}
      <Footer />
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

function ExtensionForm({ node, nodes }: { node: UiNode; nodes: Record<string, UiNode> }) {
  const fieldIds = node.children.filter((id) => {
    const child = nodes[id]
    return child && child.type.startsWith('Form.') && child.type !== 'Form.Description' && child.type !== 'Form.Separator'
  })
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const actionsSlot = findActionsSlot(node, nodes)
  const actions = actionsFromSlot(actionsSlot, nodes)
  const [actionPanelOpen, setActionPanelOpen] = useState(false)

  // Action.SubmitForm's onSubmit isn't reachable via actionsFromSlot's
  // generic PaletteAction shape (it needs the collected values as an
  // argument) — find it directly.
  const submitNode = useMemo(() => {
    function find(id: string): UiNode | undefined {
      const n = nodes[id]
      if (!n) return undefined
      if (n.props.__variant === 'submit-form') return n
      for (const childId of n.children) {
        const found = find(childId)
        if (found) return found
      }
      return undefined
    }
    return actionsSlot && find(actionsSlot.id)
  }, [actionsSlot, nodes])

  const submit = useCallback(() => {
    const id = submitNode && callbackId(submitNode.props.onSubmit)
    if (id) void invokeExtensionCallback(id, [values])
  }, [submitNode, values])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        submit()
      } else if (event.key === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        setActionPanelOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [submit])

  return (
    <div className="palette">
      <div className="openray-settings-content" style={{ overflowY: 'auto', flex: 1 }}>
        {fieldIds.map((id) => {
          const field = nodes[id]
          if (!field) return null
          const fieldId = propString(field, 'id') ?? field.id
          const title = propString(field, 'title')
          const fireOnChange = (value: unknown) => {
            const callback = callbackId(field.props.onChange)
            if (callback) void invokeExtensionCallback(callback, [value])
          }

          if (field.type === 'Form.Checkbox') {
            const checked = Boolean(values[fieldId] ?? field.props.defaultValue ?? false)
            return (
              <div className="openray-settings-row" key={field.id}>
                <label>{propString(field, 'label')}</label>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [fieldId]: e.target.checked }))
                    fireOnChange(e.target.checked)
                  }}
                />
              </div>
            )
          }

          if (field.type === 'Form.TextArea') {
            const value = (values[fieldId] as string | undefined) ?? (field.props.defaultValue as string | undefined) ?? ''
            return (
              <div className="openray-settings-row openray-settings-row--textarea" key={field.id}>
                <label>{title}</label>
                <textarea
                  className="openray-form-textarea"
                  value={value}
                  placeholder={propString(field, 'placeholder')}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [fieldId]: e.target.value }))
                    fireOnChange(e.target.value)
                  }}
                />
              </div>
            )
          }

          if (field.type === 'Form.Dropdown') {
            const value = (values[fieldId] as string | undefined) ?? (field.props.defaultValue as string | undefined) ?? ''
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
            return (
              <div className="openray-settings-row" key={field.id}>
                <label>{title}</label>
                <select
                  value={value}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [fieldId]: e.target.value }))
                    fireOnChange(e.target.value)
                  }}
                >
                  {options.map((option) => (
                    <option key={option.id} value={propString(option, 'value') ?? ''}>
                      {propString(option, 'title')}
                    </option>
                  ))}
                </select>
              </div>
            )
          }

          const value = (values[fieldId] as string | undefined) ?? (field.props.defaultValue as string | undefined) ?? ''
          return (
            <div className="openray-settings-row" key={field.id}>
              <label>{title}</label>
              <input
                type={field.type === 'Form.PasswordField' ? 'password' : 'text'}
                value={value}
                placeholder={propString(field, 'placeholder')}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [fieldId]: e.target.value }))
                  fireOnChange(e.target.value)
                }}
              />
            </div>
          )
        })}
      </div>
      {actionPanelOpen && <ActionPanel actions={actions} onClose={() => setActionPanelOpen(false)} />}
      <Footer primaryActionLabel="Submit" />
    </div>
  )
}

export function ExtensionView({ onBack }: { onBack?: () => void } = {}) {
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
      return <ExtensionList key={root.id} node={root} nodes={nodes} onBack={onBack} />
    case 'Grid':
      return <ExtensionGrid key={root.id} node={root} nodes={nodes} onBack={onBack} />
    case 'Detail':
      return <ExtensionDetail key={root.id} node={root} nodes={nodes} />
    case 'Form':
      return <ExtensionForm key={root.id} node={root} nodes={nodes} />
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
