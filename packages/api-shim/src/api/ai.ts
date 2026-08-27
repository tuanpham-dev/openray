import { getHostBridge } from '../bridge'

/** AI settings read live from the app (not extension storage) — same
 *  reasoning as `notes.ts`'s `getNotesSettings`: these are ordinary app
 *  settings a user edits in Settings → General/AI, not extension-owned
 *  data. `aiCustomClis`' argv templates stay here too since the CLI
 *  provider needs them exactly as configured. */
export interface AiSettings {
  aiDefaultModel: string
  aiQuickModel: string
  aiProfile: string
  aiSkillDirs: string[]
  aiCustomClis: { name: string; command: string[] }[]
}

export async function getAiSettings(): Promise<AiSettings> {
  return (await getHostBridge().call('host.ai.getSettings')) as unknown as AiSettings
}
