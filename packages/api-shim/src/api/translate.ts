import { getHostBridge } from '../bridge'

/** T22: app-wide Translate settings — edited from Settings → Translate
 * (a pane that stays native, since these are generic app preferences,
 * not extension-owned data), read live on every call. */
export interface TranslateSettings {
  targetLanguage: string
  sourceLanguage: string
  primaryAction: 'copy' | 'paste'
  historyEnabled: boolean
}

export async function getTranslateSettings(): Promise<TranslateSettings> {
  return (await getHostBridge().call('host.translate.getSettings')) as unknown as TranslateSettings
}

/** Persists an explicit user pick of the target language — the one
 * Translate setting native `TranslateView.tsx` ever wrote back on change
 * (source language is deliberately never persisted). */
export async function setTranslateTargetLanguage(code: string): Promise<void> {
  await getHostBridge().call('host.translate.setTargetLanguage', { code })
}
