import { evaluate } from '@openray/calculator-core'
import { ensureRatesFresh, getRateTable } from './rates'

/** Contributes no static rows — calculator has no command surface at
 * all natively either (confirmed by reading `api/search.rs`:
 * `calculator::evaluate` was called directly inside `search_inner`, with
 * no `CommandProvider`, no registry registration, no static or dynamic
 * `Command`s). This listing exists purely so `onQuery` below has a
 * root-provider command to attach to, and so T14's
 * `spawn_root_provider_startup` gives currency rates their "fetch once,
 * at app start" trigger for free — see `rates.ts`'s doc comment. */
export default async function listRootCommands() {
  await ensureRatesFresh()
  return []
}

/** Never reached: this command contributes no rows, so there is nothing
 * for the palette to activate headlessly. Present only so the module
 * satisfies the root-provider contract. */
export async function execute(): Promise<void> {}

interface OnQueryContext {
  aliases: Record<string, string>
}

/** T21 inline row: runs every one of the five ported sub-evaluators
 * (`@openray/calculator-core`'s `evaluate`, first-match-wins, mirroring
 * native `mod.rs`) synchronously against the live currency-rate cache —
 * never fetches, matching the "must never block or touch the network"
 * invariant native's own `evaluate()` had, now enforced by `rates.ts`
 * only ever fetching from the root-provider listing, not from here. */
export async function onQuery(query: string, _context: OnQueryContext) {
  const table = await getRateTable()
  const calc = evaluate(query, table)
  if (!calc) return null

  return {
    id: 'calc',
    title: calc.result,
    subtitle: calc.expression,
    value: calc.result,
    valueRaw: calc.resultRaw,
    display: 'card',
    sectionLabel: 'Calculator',
    cardLeft: calc.expression,
  }
}
