import { invoke } from '@tauri-apps/api/core'
import type { PaletteItemKind } from '../components/types'

export interface SettingsCommand {
  id: string
  title: string
  subtitle?: string | null
  icon?: string | null
  kind: PaletteItemKind
  keywords: string[]
  requiresArgument: boolean
}

export interface CommandSettingsEntry {
  alias: string | null
  hotkey: string | null
  enabled: boolean
}

export function listSettingsCommands(): Promise<SettingsCommand[]> {
  return invoke('list_settings_commands')
}

export function listCommandSettings(): Promise<Record<string, CommandSettingsEntry>> {
  return invoke('list_command_settings')
}

export function setCommandHotkey(commandId: string, hotkey: string | null): Promise<void> {
  return invoke('set_command_hotkey', { commandId, hotkey })
}

export function setCommandAlias(commandId: string, alias: string | null): Promise<void> {
  return invoke('set_command_alias', { commandId, alias })
}

export function setCommandEnabled(commandId: string, enabled: boolean): Promise<void> {
  return invoke('set_command_enabled', { commandId, enabled })
}
