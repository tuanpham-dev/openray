import { invoke } from '@tauri-apps/api/core'

/** One extension offering Import/Export, from its manifest's `export`
 *  declaration. Built from the registry, so listing these starts nothing. */
export interface ExportCategory {
  id: string
  title: string
  description: string | null
}

/** Which extensions an export covers. `all` is kept distinct from listing
 *  every id: it means "whatever is installed", matching the master
 *  checkbox being checked rather than every child happening to be. */
export interface ExtensionSelection {
  all: boolean
  ids: string[]
}

/** Which categories an export includes — chosen per export in the
 *  Import / Export pane rather than persisted as settings. */
export interface ExportScope {
  core: boolean
  extensions: ExtensionSelection
  clipboard: boolean
  usage: boolean
}

/** A saved credential an export would carry: a stored value for a
 *  preference its extension declared as `password`. */
export interface PasswordPreference {
  extensionId: string
  extensionTitle: string
  name: string
}

export interface ExportFileInfo {
  /** Whether reading this file needs a passphrase. Comes from the file's
   *  plaintext header, so it's known before prompting the user. */
  encrypted: boolean
  /** The writing app's snapshot version — diagnostics only; import
   *  deliberately accepts any version. */
  version: number
}

/** `failures` is `[extensionId, message]` — one extension's broken hook
 *  never fails the whole operation, so partial success is the normal
 *  shape of both results. */
export interface ExportSummary {
  extensionsExported: string[]
  failures: [string, string][]
}

export interface ImportSummary {
  recordsApplied: number
  settingsApplied: boolean
  extensionsImported: string[]
  /** Extensions the file carried data for that aren't installed here. */
  skippedExtensions: string[]
  failures: [string, string][]
}

/** The extensions currently offering Import/Export. Disabled extensions
 *  are deliberately absent. */
export function listExportCategories(): Promise<ExportCategory[]> {
  return invoke('list_export_categories')
}

/** The saved credentials an export with this scope would carry, so the
 *  pane can warn before writing anything. */
export function inspectExportSensitivity(extensions: ExtensionSelection): Promise<PasswordPreference[]> {
  return invoke('inspect_export_sensitivity', { allExtensions: extensions.all, extensions: extensions.ids })
}

/** Reads an export file's header so Import knows whether to prompt for a
 *  passphrase. Rejects a file that isn't an OpenRay export. */
export function inspectExportFile(path: string): Promise<ExportFileInfo> {
  return invoke('inspect_export_file', { path })
}

/** Writes the selected categories to `path`. `passphrase` is null when the
 *  user chose to export without encryption. `includePasswordPreferences`
 *  carries the answer to the credential warning — excluding is enforced
 *  backend-side, so passing false really does omit them. */
export function exportData(
  path: string,
  passphrase: string | null,
  scope: ExportScope,
  includePasswordPreferences: boolean,
): Promise<ExportSummary> {
  return invoke('export_data', {
    path,
    passphrase,
    core: scope.core,
    allExtensions: scope.extensions.all,
    extensions: scope.extensions.ids,
    clipboard: scope.clipboard,
    usage: scope.usage,
    includePasswordPreferences,
  })
}

/** Merges an export file into this machine's data (last-writer-wins, so an
 *  older file never clobbers newer local edits), then hands each
 *  extension's own payload back to it. */
export function importData(path: string, passphrase: string | null): Promise<ImportSummary> {
  return invoke('import_data', { path, passphrase })
}
