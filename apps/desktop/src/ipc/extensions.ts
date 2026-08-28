import { invoke } from '@tauri-apps/api/core'

export interface ExtensionEntry {
  id: string
  title: string
  path: string | null
  enabled: boolean
  description: string | null
  source: string
  icon: string | null
  /** The installed version, when the manifest declared one. */
  version: string | null
  /** The registry this came from, or null when it didn't come from one. */
  sourceUrl: string | null
}

export function listExtensions(): Promise<ExtensionEntry[]> {
  return invoke('list_extensions')
}

export function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke('set_extension_enabled', { id, enabled })
}

export function installExtensionFromPath(path: string): Promise<ExtensionEntry> {
  return invoke('install_extension_from_path', { path })
}

export function installExtensionFromSlug(slug: string): Promise<ExtensionEntry> {
  return invoke('install_extension_from_slug', { slug })
}

/**
 * Installs a prebuilt `.orx` archive. Unlike the path/slug installs, this
 * needs no git, npm, or compiler on the machine — the archive already
 * carries built command bundles.
 */
export function installExtensionFromArchive(path: string, sourceUrl?: string): Promise<ExtensionEntry> {
  return invoke('install_extension_from_archive', { path, sourceUrl: sourceUrl ?? null })
}

export function uninstallExtension(id: string): Promise<void> {
  return invoke('uninstall_extension', { id })
}

/** A directory currently being watched in dev mode. */
export interface DevSession {
  id: string
  dir: string
}

/**
 * Payload of the `extension-dev-build` event — one rebuild of an extension
 * being developed in place. `manifestChanged` means the platform has
 * already re-registered the extension by the time this arrives, so a
 * listener can trust `listExtensions()` to reflect the new manifest.
 */
export interface DevBuildEvent {
  extensionId: string
  dir: string
  commands: string[]
  manifestChanged: boolean
  errors: string[]
  durationMs: number
}

/** Builds `path` in place and starts watching it — see `dev_extensions`. */
export function developExtension(path: string): Promise<ExtensionEntry> {
  return invoke('develop_extension', { path })
}

/** Stops watching, leaving the extension registered and runnable. */
export function stopDeveloping(id: string): Promise<void> {
  return invoke('stop_developing', { id })
}

/** Unregisters a dev extension without deleting the author's folder. */
export function removeDevExtension(id: string): Promise<void> {
  return invoke('remove_dev_extension', { id })
}

export function listDevExtensions(): Promise<DevSession[]> {
  return invoke('list_dev_extensions')
}

export type PreferenceType = 'textfield' | 'password' | 'checkbox' | 'dropdown' | 'appPicker' | 'file' | 'directory'

export interface PreferenceOptionRow {
  title: string
  value: string
}

export interface PreferenceDefinition {
  extensionId: string
  commandName: string
  name: string
  preferenceType: PreferenceType
  title: string | null
  label: string | null
  description: string | null
  required: boolean
  defaultValue: unknown
  placeholder: string | null
  data: PreferenceOptionRow[] | null
}

export function extensionPreferenceDefinitions(id: string): Promise<PreferenceDefinition[]> {
  return invoke('extension_preference_definitions', { id })
}

export function extensionPreferenceValues(id: string): Promise<Record<string, unknown>> {
  return invoke('extension_preference_values', { id })
}

export function setExtensionPreferenceValue(id: string, name: string, value: unknown): Promise<void> {
  return invoke('set_extension_preference_value', { id, name, value })
}
