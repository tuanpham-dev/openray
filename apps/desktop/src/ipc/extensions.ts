import { invoke } from '@tauri-apps/api/core'

export interface ExtensionEntry {
  id: string
  title: string
  path: string | null
  enabled: boolean
  description: string | null
  source: string
  icon: string | null
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

export function uninstallExtension(id: string): Promise<void> {
  return invoke('uninstall_extension', { id })
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
