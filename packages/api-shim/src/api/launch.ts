import { getHostBridge } from '../bridge'
import { getCommandContext } from './command-context'
// The one `LaunchType` — `environment.launchType` already reports with it,
// and two enums with the same name would drift.
import { LaunchType } from './environment'

export interface LaunchOptions {
  /** The target command's `name` from its manifest. */
  name: string
  type?: LaunchType
  /** Another extension's name; defaults to the caller's own. */
  extensionName?: string
  /** Accepted for signature parity — the registry keys extensions by id
   *  alone, so there is no author namespace to disambiguate against. */
  ownerOrAuthorName?: string
  /** Arbitrary payload the target reads as `props.launchContext`. */
  context?: Record<string, unknown>
  /** Values for the target's manifest-declared arguments. */
  arguments?: Record<string, string>
  fallbackText?: string
}

/**
 * Launches another command.
 *
 * 25 of 180 sampled extensions call this, and it is half of one feature
 * with `LaunchProps` (36) — a command hands the next one a payload, which
 * is how an extension splits work across commands at all. As a stub the
 * call vanished, so the second command simply never ran.
 *
 * Cross-extension launching is allowed, matching Raycast. That is a real
 * capability, but not a new one: an extension already runs arbitrary Node
 * here, so a narrower rule would stop nothing and only break honest
 * callers. Worth knowing that every one of those 75 call sites in the
 * sample targets the extension's *own* commands.
 */
export async function launchCommand(options: LaunchOptions): Promise<void> {
  const context = getCommandContext()
  await getHostBridge().call('host.launch', {
    // The caller's own id, so an extension that omits `extensionName`
    // cannot accidentally address someone else's command.
    callerExtensionId: context.extensionId,
    extensionName: options.extensionName ?? null,
    commandName: options.name,
    type: options.type ?? LaunchType.UserInitiated,
    context: (options.context ?? null) as never,
    arguments: (options.arguments ?? null) as never,
    fallbackText: options.fallbackText ?? null,
  })
}
