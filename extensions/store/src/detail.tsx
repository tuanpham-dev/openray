import { Action, ActionPanel, Detail, Icon, open } from '@raycast/api'
import type { Catalog, CatalogEntry, InstalledExtensionRow } from '@openray/extras'

export interface DetailRow {
  entry: CatalogEntry
  catalog: Catalog
  installed?: InstalledExtensionRow
  updatable: boolean
}

/**
 * One extension, opened from the Store list.
 *
 * The list deliberately stays a plain full-width list — a side-by-side detail
 * pane has to shrink both halves to fit, and an extension's description is the
 * one thing someone is actually reading when they browse. Pushing a view
 * instead gives the description the whole width and leaves room for the
 * metadata that would never have fitted in a row.
 */
export function StoreDetail({
  row,
  busy,
  onInstall,
  onUninstall,
}: {
  row: DetailRow
  busy: boolean
  onInstall: () => void
  onUninstall: () => void
}) {
  const { entry, catalog, installed } = row

  const readmeUrl = entry.readme
    ? new URL(entry.readme, catalog.sourceUrl).toString()
    : null

  // Joined with blank lines so each becomes its own paragraph. Built as a
  // filtered list of *blocks* rather than lines with `''` spacers between
  // them — a spacer is falsy, so filtering lines would strip exactly the
  // blank lines that separate the paragraphs and run them all together.
  // Screenshots lead, then a labelled description, then the commands —
  // the order Raycast's own store detail uses, and the order someone reads
  // in: what it looks like, what it is, what it actually does.
  //
  // The shots are joined by a space rather than blank lines so they sit on
  // one row as inline images instead of stacking full-width down the page.
  const screenshots = (entry.screenshots ?? []).map((url) => `![](${url})`).join(' ')

  const commandLines = (entry.commands ?? []).flatMap((command) => [
    `**${command.title}**`,
    command.description ?? '',
  ])

  const markdown = [
    screenshots,
    installed ? `**Installed** · version ${installed.version ?? 'unknown'}` : '',
    row.updatable ? `**Update available** · ${installed?.version ?? '?'} → ${entry.version}` : '',
    entry.description ? '## Description' : '',
    entry.description ?? '',
    entry.commands && entry.commands.length > 0 ? '## Commands' : '',
    ...commandLines,
  ]
    .filter(Boolean)
    .join('\n\n')

  const metadata = (
    <Detail.Metadata>
      {entry.author && <Detail.Metadata.Label title="Author" text={entry.author} />}
      {entry.version && <Detail.Metadata.Label title="Version" text={entry.version} />}
      <Detail.Metadata.Label title="From" text={catalog.name ?? catalog.sourceUrl} />
      {entry.categories && entry.categories.length > 0 && (
        <Detail.Metadata.Label title="Categories" text={entry.categories.join(', ')} />
      )}
      {entry.platforms && entry.platforms.length > 0 && (
        <Detail.Metadata.Label title="Platforms" text={entry.platforms.join(', ')} />
      )}
      {/* Honest about what the digest proves: it pins the archive to this
          catalog, and says nothing about who published the catalog. No
          separator ahead of it — every row already draws its own rule, so a
          separator only added a gap that read as a broken last row. */}
      <Detail.Metadata.Label
        title="Integrity"
        text={entry.sha256 ? 'Checksum verified on download' : 'No checksum declared'}
      />
    </Detail.Metadata>
  )

  return (
    <Detail
      navigationTitle={entry.title}
      isLoading={busy}
      markdown={markdown}
      metadata={metadata}
      actions={
        <ActionPanel>
          {/* Ordering is the whole point of this panel: the first action is
              what Enter does, so it has to be the one thing someone opened
              this view to do — update if there is one, install if it isn't
              here yet, and never uninstall by default. */}
          {row.updatable && (
            <Action title={`Update to ${entry.version}`} icon={Icon.Download} onAction={onInstall} />
          )}
          {!installed && <Action title="Install" icon={Icon.Download} onAction={onInstall} />}
          {readmeUrl && <Action title="Open README" icon={Icon.Globe} onAction={() => void open(readmeUrl)} />}
          {installed && !row.updatable && (
            <Action title="Reinstall" icon={Icon.Download} onAction={onInstall} />
          )}
          {installed && installed.source !== 'builtin' && (
            <Action title="Uninstall" icon={Icon.Trash} style="destructive" onAction={onUninstall} />
          )}
        </ActionPanel>
      }
    />
  )
}
