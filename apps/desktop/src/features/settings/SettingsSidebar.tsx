import { useMemo, useState } from 'react'
import { AdvancedIcon, AppWindowIcon, CloudIcon, GearIcon, PlusIcon, PuzzleIcon, SearchIcon } from '../../components/icons'
import { THEME_ICONS, ThemeIcon } from './extensionIcons'
import { IconGlyph } from '../../components/IconGlyph'
import type { ExtensionEntry } from '../../ipc/extensions'

export type SettingsSelection =
  | { kind: 'general' }
  | { kind: 'sync' }
  | { kind: 'advanced' }
  | { kind: 'applications' }
  | { kind: 'install' }
  | { kind: 'extension'; id: string }

function selectionKey(selection: SettingsSelection): string {
  return selection.kind === 'extension' ? `extension:${selection.id}` : selection.kind
}

interface SettingsSidebarProps {
  extensions: ExtensionEntry[]
  selection: SettingsSelection
  onChange: (selection: SettingsSelection) => void
}

export function SettingsSidebar({ extensions, selection, onChange }: SettingsSidebarProps) {
  const [search, setSearch] = useState('')

  const sortedExtensions = useMemo(() => [...extensions].sort((a, b) => a.title.localeCompare(b.title)), [extensions])

  const searchLower = search.trim().toLowerCase()
  const matches = (title: string) => !searchLower || title.toLowerCase().includes(searchLower)

  const activeKey = selectionKey(selection)

  return (
    <nav className="openray-settings-sidebar">
      <div className="openray-settings-sidebar-search">
        <SearchIcon size={14} className="openray-settings-sidebar-search-icon" />
        <input type="text" placeholder="Search settings…" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>

      <div className="openray-settings-sidebar-scroll">
        <div className="openray-settings-sidebar-section">
          <span className="openray-settings-sidebar-heading">Settings</span>
          {matches('General') && (
            <SidebarEntry icon={<GearIcon size={16} />} title="General" active={activeKey === 'general'} onClick={() => onChange({ kind: 'general' })} />
          )}
          {matches('Cloud Sync') && (
            <SidebarEntry icon={<CloudIcon size={16} />} title="Cloud Sync" active={activeKey === 'sync'} onClick={() => onChange({ kind: 'sync' })} />
          )}
          {matches('Advanced') && (
            <SidebarEntry
              icon={<AdvancedIcon size={16} />}
              title="Advanced"
              active={activeKey === 'advanced'}
              onClick={() => onChange({ kind: 'advanced' })}
            />
          )}
        </div>

        <div className="openray-settings-sidebar-section">
          <span className="openray-settings-sidebar-heading">
            Extensions
            <button type="button" className="openray-settings-sidebar-add" aria-label="Install extension" onClick={() => onChange({ kind: 'install' })}>
              <PlusIcon size={13} />
            </button>
          </span>
          {matches('Applications') && (
            <SidebarEntry
              icon={
                <ThemeIcon names={THEME_ICONS.applications}>
                  <AppWindowIcon size={16} />
                </ThemeIcon>
              }
              title="Applications"
              active={activeKey === 'applications'}
              onClick={() => onChange({ kind: 'applications' })}
            />
          )}
          {sortedExtensions.filter((extension) => matches(extension.title)).map((extension) => (
            <SidebarEntry
              key={extension.id}
              icon={
                <IconGlyph
                  icon={extension.icon}
                  size={18}
                  imageClassName="openray-settings-row-icon-image"
                  fallback={
                    <ThemeIcon names={THEME_ICONS.extension}>
                      <PuzzleIcon size={18} />
                    </ThemeIcon>
                  }
                />
              }
              title={extension.title}
              active={activeKey === `extension:${extension.id}`}
              dimmed={!extension.enabled}
              onClick={() => onChange({ kind: 'extension', id: extension.id })}
            />
          ))}
        </div>
      </div>
    </nav>
  )
}

interface SidebarEntryProps {
  icon: React.ReactNode
  title: string
  active: boolean
  dimmed?: boolean
  onClick: () => void
}

function SidebarEntry({ icon, title, active, dimmed, onClick }: SidebarEntryProps) {
  return (
    <button
      type="button"
      className={`openray-settings-sidebar-entry${active ? ' openray-settings-sidebar-entry--active' : ''}${dimmed ? ' openray-settings-sidebar-entry--dimmed' : ''}`}
      onClick={onClick}
    >
      <span className="openray-settings-sidebar-entry-icon">{icon}</span>
      <span className="openray-settings-sidebar-entry-title">{title}</span>
    </button>
  )
}
