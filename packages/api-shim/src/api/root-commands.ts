import { getHostBridge } from '../bridge'
import { getCommandContext } from './command-context'

/**
 * One row a `root-provider` command contributes to root search — the
 * shape its default-exported listing function's `Promise<RootCommand[]>`
 * resolves to. `id` is opaque and extension-defined; Rust namespaces it
 * as `ext:{extensionId}:{id}` on arrival and reuses it end to end for
 * usage/frecency/`command_settings` (alias, hotkey, enabled), so it must
 * stay stable across refreshes for the same logical row.
 */
export interface RootCommand {
  id: string
  title: string
  subtitle?: string
  icon?: string
  keywords?: string[]
  /** Routes activation through the argument bar first, same as a static
   * manifest command declaring `arguments[]`. */
  requiresArgument?: boolean
  /** Routes activation through the palette's confirm surface instead of
   * running headless off a hotkey. */
  needsConfirm?: boolean
  /** Routes activation through the palette (a view) instead of running
   * headless. */
  opensView?: boolean
}

/**
 * T21: a `root-provider` command may also export a named `onQuery(query,
 * context): Promise<InlineRow | null>` — called on (roughly) every
 * debounced keystroke while the user is searching, off the search list's
 * own synchronous path. Returning `null` contributes nothing for that
 * query. `id` only needs to be unique within this extension's own inline
 * contribution for a single query, not stable across queries — unlike a
 * `RootCommand`'s id, nothing (usage, frecency, `command_settings`) keys
 * on it.
 */
export interface InlineRow {
  id: string
  title: string
  subtitle?: string
  icon?: string
  /** What activating the row (Enter) copies to the clipboard — there's no
   * second round trip back into the extension to decide this at
   * activation time, so it must already be known when `onQuery` returns
   * the row. Omitted means the row isn't activatable (informational only). */
  value?: string
  /** T23: an alternate, unformatted form of `value` — backs ⌘Enter
   * (native calculator's "Copy Unformatted Answer"), for pasting
   * somewhere that expects a plain machine-parseable number rather than
   * `value`'s locale-formatted display form. Omitted means ⌘Enter falls
   * back to copying `value` (no separate raw form to offer). ⌘⇧Enter
   * ("Copy Question and Answer") needs no dedicated field — the host
   * composes it from `subtitle` (the expression) and `value` (the
   * answer) directly. */
  valueRaw?: string
  /** Opts into the large Raycast-style result card instead of a plain
   * list row — a raised panel with an optional `sectionLabel` heading
   * above a `cardLeft`/`cardRight ?? title` split (calculator, translate)
   * or an icon/text split when `cardLeft` is omitted (notes). */
  display?: 'card'
  /** Heading shown above the card, e.g. "Calculator" or "Translate to
   * German". Only meaningful when `display` is `'card'`. */
  sectionLabel?: string
  /** Left half of the card (e.g. the expression or source text). When
   * omitted, the left half renders the row's `icon` instead and no
   * divider/arrow is drawn between the halves. */
  cardLeft?: string
  /** Right half of the card; falls back to `title` when omitted. Lets a
   * row keep a more descriptive `title` for the plain-row fallback while
   * the card shows a shorter value. */
  cardRight?: string
}

/** Passed to `onQuery` as its second argument. */
export interface InlineQueryContext {
  /** This extension's own alias assignments, keyed by the opaque id/host
   *  command name (not the full `ext:{extensionId}:{id}` form). */
  aliases: Record<string, string>
}

/**
 * Re-requests this extension's `root-provider` listing — call after a
 * write that changes what it should contribute (creating/deleting/
 * renaming a row), so root search reflects it without waiting for the
 * next natural remount. Fire-and-forget: the refreshed rows arrive
 * separately, asynchronously, the same way the initial listing does at
 * host start — this call doesn't wait for them either.
 */
export async function refreshRootCommands(): Promise<void> {
  await getHostBridge().call('host.system.refreshRootCommands', { extensionId: getCommandContext().extensionId })
}
