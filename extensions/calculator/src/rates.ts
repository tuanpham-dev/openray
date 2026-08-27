import { LocalStorage } from '@raycast/api'
import type { RateTable } from '@openray/calculator-core'

/** Ported from `application/calculator/currency.rs`'s `spawn_rate_refresh`
 * — see that module's (deleted) doc comment: rates live in a cache read
 * synchronously by every currency query, populated separately so the hot
 * query path never touches the network. `LocalStorage` (backed by
 * `extension_storage`, a local SQLite table) replaces the native
 * `rates.json` file directly — same shape, same 12h staleness window. */

const RATES_URL = 'https://open.er-api.com/v6/latest/USD'
const STALE_AFTER_MS = 12 * 60 * 60 * 1000
const STORAGE_KEY = 'rates'

interface ApiResponse {
  result: string
  base_code: string
  rates: Record<string, number>
}

/** One HTTPS GET — only ever called from `ensureRatesFresh`, never from
 * `onQuery` (the hot per-keystroke path). */
async function fetchRates(): Promise<RateTable | undefined> {
  try {
    const response = await fetch(RATES_URL)
    if (!response.ok) return undefined
    const body = (await response.json()) as ApiResponse
    if (body.result !== 'success') return undefined
    const rates: Record<string, number> = {}
    for (const [code, rate] of Object.entries(body.rates)) rates[code.toUpperCase()] = rate
    return { base: body.base_code.toUpperCase(), rates, fetchedAt: Date.now() }
  } catch {
    return undefined
  }
}

/** Reads the current cache — `undefined` when none has ever been saved
 * (first run, before the first `ensureRatesFresh` lands, or it failed
 * with no prior cache either). A *stale* cache is still returned as-is:
 * "yesterday's rates, no complaint" is deliberate, matching native. */
export async function getRateTable(): Promise<RateTable | undefined> {
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as RateTable
  } catch {
    return undefined
  }
}

/** Fetches fresh rates only if the cache is missing or older than 12
 * hours — called once, from the root-provider listing (`list.ts`), which
 * T14's `spawn_root_provider_startup` already invokes once at app start
 * for every installed root-provider command. That's the "once, at
 * startup" trigger `spawn_rate_refresh` needed, reproduced with zero new
 * host infrastructure — deliberately *not* re-checked inline during
 * `onQuery`, which must stay a synchronous read of whatever the cache
 * already holds. */
export async function ensureRatesFresh(): Promise<void> {
  const cached = await getRateTable()
  const needFetch = !cached || Date.now() - cached.fetchedAt > STALE_AFTER_MS
  if (!needFetch) return
  const fresh = await fetchRates()
  if (fresh) await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(fresh))
}
