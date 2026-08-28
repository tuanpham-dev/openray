import { invoke } from '@tauri-apps/api/core'

/** A registry the user has added — see `application::registry_sources`. */
export interface RegistrySource {
  url: string
  name: string | null
  enabled: boolean
  autoUpdate: boolean
  addedAt: number
}

export function listRegistrySources(): Promise<RegistrySource[]> {
  return invoke('list_registry_sources')
}

/**
 * Adds a registry after checking its catalog reads. Extensions from a
 * registry run as unsigned code with the user's own privileges, so the
 * caller must confirm with the user before calling this — adding a source
 * is the trust decision, not installing from it.
 */
export function addRegistrySource(url: string): Promise<RegistrySource> {
  return invoke('add_registry_source', { url })
}

export function removeRegistrySource(url: string): Promise<void> {
  return invoke('remove_registry_source', { url })
}

export function setRegistrySourceEnabled(url: string, enabled: boolean): Promise<void> {
  return invoke('set_registry_source_enabled', { url, enabled })
}

export function setRegistrySourceAutoUpdate(url: string, autoUpdate: boolean): Promise<void> {
  return invoke('set_registry_source_auto_update', { url, autoUpdate })
}

/** An automatic update pass's outcome, as broadcast on `extension-updates`. */
export interface UpdateReport {
  applied: { id: string; from: string | null; to: string; sourceUrl: string; error: string | null }[]
  pending: { id: string; from: string | null; to: string; sourceUrl: string }[]
  unreachable: string[]
}
