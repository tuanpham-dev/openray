import { useCallback, useEffect, useMemo, useState } from 'react'
import { Action, ActionPanel, Icon, List, confirmAlert, showToast, Toast } from '@raycast/api'
import {
  classifyInstall,
  fetchCatalog,
  installFromRegistry,
  listInstalledExtensions,
  listRegistrySources,
  uninstallExtension,
  type Catalog,
  type CatalogEntry,
  type InstalledExtensionRow,
} from '@openray/extras'

/**
 * The Store is an ordinary first-party extension rather than a native pane,
 * which is the architecture's own rule applied to itself: everything except
 * app-search rows is an extension. It reads catalogs and installs through
 * `host.registry.*`, so the platform stays the one deciding what may
 * replace what.
 */

interface Row {
  entry: CatalogEntry
  catalog: Catalog
  installed?: InstalledExtensionRow
  /** Set when the entry is newer than what's installed from this registry. */
  updatable: boolean
}

/** Mirrors the platform's own comparison (`auto_update::is_newer`) closely
 *  enough for a label; the platform remains the authority on whether an
 *  update actually applies. */
function isNewer(installed: string | null | undefined, candidate: string | undefined): boolean {
  if (!candidate) return false
  if (!installed) return true
  if (installed === candidate) return false
  const parse = (value: string) => {
    const parts = value.split('+')[0]?.split('.') ?? []
    const numbers = parts.map((part) => Number(part))
    return numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : null
  }
  const current = parse(installed)
  const next = parse(candidate)
  if (!current || !next) return true
  for (let index = 0; index < Math.max(current.length, next.length); index += 1) {
    const a = current[index] ?? 0
    const b = next[index] ?? 0
    if (a !== b) return b > a
  }
  return false
}

function sameSource(a: string | null | undefined, b: string): boolean {
  const normalize = (value: string) => (value.endsWith('/') ? value : `${value}/`)
  return a != null && normalize(a) === normalize(b)
}

/** The current OS, for filtering entries that declare `platforms`. */
function currentPlatform(): string {
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  return 'Linux'
}

export default function Command() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [offlineSources, setOfflineSources] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [sources, installed] = await Promise.all([listRegistrySources(), listInstalledExtensions()])
      if (sources.length === 0) {
        setRows([])
        setError(null)
        return
      }

      const installedById = new Map(installed.map((row) => [row.id, row]))
      const platform = currentPlatform()
      const collected: Row[] = []
      const offline: string[] = []
      const failures: string[] = []

      // Sequential rather than parallel: catalogs are ETag-cached and
      // usually a 304, and one slow registry shouldn't be able to stall
      // the others behind a Promise.all that only settles when all do.
      for (const source of sources) {
        try {
          const catalog = await fetchCatalog(source.url)
          if (catalog.fromCache) offline.push(catalog.name ?? source.url)
          for (const entry of catalog.extensions) {
            // An extension that doesn't run here shouldn't be offered here.
            if (entry.platforms && entry.platforms.length > 0 && !entry.platforms.includes(platform)) continue
            const existing = installedById.get(entry.name)
            collected.push({
              entry,
              catalog,
              ...(existing ? { installed: existing } : {}),
              updatable: Boolean(existing && sameSource(existing.sourceUrl, catalog.sourceUrl) && isNewer(existing.version, entry.version)),
            })
          }
        } catch (err) {
          failures.push(`${source.name ?? source.url}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      setRows(collected)
      setOfflineSources(offline)
      setError(failures.length > 0 ? failures.join('\n') : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRows([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const install = useCallback(
    async (row: Row) => {
      setBusy(row.entry.name)
      try {
        const impact = await classifyInstall(row.entry.name, row.catalog.sourceUrl)
        if (impact.kind === 'blocked') {
          await showToast({ style: Toast.Style.Failure, title: 'Cannot install', message: impact.reason })
          return
        }
        if (impact.kind === 'replace') {
          // Cross-registry replacement is never silent: the two share this
          // extension's stored data, and only the user can say whether
          // that's what they meant.
          const confirmed = await confirmAlert({
            title: `Replace ${row.entry.title}?`,
            message: `${row.entry.name} is currently installed from ${impact.currentSource ?? 'another source'}. Installing from ${row.catalog.name ?? row.catalog.sourceUrl} replaces it, and both share the extension's stored data.`,
            primaryAction: { title: 'Replace' },
          })
          if (!confirmed) return
        }

        await installFromRegistry({
          sourceUrl: row.catalog.sourceUrl,
          fileUrl: row.entry.file,
          ...(row.entry.sha256 ? { sha256: row.entry.sha256 } : {}),
        })
        await showToast({
          style: Toast.Style.Success,
          title: impact.kind === 'update' ? `Updated ${row.entry.title}` : `Installed ${row.entry.title}`,
          ...(row.entry.version ? { message: `Version ${row.entry.version}` } : {}),
        })
        await load()
      } catch (err) {
        await showToast({
          style: Toast.Style.Failure,
          title: `Could not install ${row.entry.title}`,
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  const remove = useCallback(
    async (row: Row) => {
      const confirmed = await confirmAlert({
        title: `Uninstall ${row.entry.title}?`,
        message: 'Its stored data is kept, so reinstalling later restores it.',
        primaryAction: { title: 'Uninstall' },
      })
      if (!confirmed) return
      setBusy(row.entry.name)
      try {
        await uninstallExtension(row.entry.name)
        await showToast({ style: Toast.Style.Success, title: `Uninstalled ${row.entry.title}` })
        await load()
      } catch (err) {
        await showToast({
          style: Toast.Style.Failure,
          title: `Could not uninstall ${row.entry.title}`,
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  const sections = useMemo(() => {
    const all = rows ?? []
    const updates = all.filter((row) => row.updatable)
    const available = all.filter((row) => !row.installed)
    const installed = all.filter((row) => row.installed && !row.updatable)
    return { updates, available, installed }
  }, [rows])

  if (rows !== null && rows.length === 0) {
    return (
      <List searchBarPlaceholder="Search extensions…">
        <List.EmptyView
          title={error ? 'No extensions could be loaded' : 'No registries yet'}
          description={
            error ??
            'Add a registry in Settings → Add Extension → Manage Registries. A registry is any URL serving an index.json catalog.'
          }
        />
      </List>
    )
  }

  const detail = (row: Row) => {
    const lines = [
      `# ${row.entry.title}`,
      row.entry.description ?? '',
      '',
      row.entry.version ? `**Version** ${row.entry.version}` : '',
      row.entry.author ? `**Author** ${row.entry.author}` : '',
      `**From** ${row.catalog.name ?? row.catalog.sourceUrl}`,
      row.installed?.version ? `**Installed** ${row.installed.version}` : '',
      '',
      // Honest about what the digest does and doesn't prove — it pins the
      // file to the catalog, not to any particular publisher.
      row.entry.sha256 ? '_Verified against the catalog’s checksum on download._' : '_This catalog declares no checksum._',
    ]
    return lines.filter(Boolean).join('\n')
  }

  const actionsFor = (row: Row) => (
    <ActionPanel>
      {row.updatable && <Action title={`Update to ${row.entry.version}`} onAction={() => void install(row)} />}
      {!row.installed && <Action title="Install" onAction={() => void install(row)} />}
      {row.installed && !row.updatable && <Action title="Reinstall" onAction={() => void install(row)} />}
      {row.installed && row.installed.source !== 'builtin' && (
        <Action title="Uninstall" onAction={() => void remove(row)} />
      )}
      <Action title="Refresh Catalogs" onAction={() => void load()} />
    </ActionPanel>
  )

  const item = (row: Row) => (
    <List.Item
      key={`${row.catalog.sourceUrl}:${row.entry.name}`}
      title={row.entry.title}
      subtitle={row.entry.description ?? ''}
      icon={row.entry.icon ?? Icon.Download}
      accessories={[
        ...(busy === row.entry.name ? [{ text: 'Working…' }] : []),
        ...(row.entry.version ? [{ text: row.entry.version }] : []),
        { text: row.catalog.name ?? row.catalog.sourceUrl },
      ]}
      detail={<List.Item.Detail markdown={detail(row)} />}
      actions={actionsFor(row)}
    />
  )

  return (
    <List isLoading={rows === null} isShowingDetail searchBarPlaceholder="Search extensions…">
      {offlineSources.length > 0 && (
        <List.Section title={`Showing cached results for ${offlineSources.join(', ')}`}>{[]}</List.Section>
      )}
      {sections.updates.length > 0 && (
        <List.Section title="Updates Available">{sections.updates.map(item)}</List.Section>
      )}
      {sections.available.length > 0 && <List.Section title="Available">{sections.available.map(item)}</List.Section>}
      {sections.installed.length > 0 && <List.Section title="Installed">{sections.installed.map(item)}</List.Section>}
    </List>
  )
}
