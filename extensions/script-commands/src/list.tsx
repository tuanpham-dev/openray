import { dirname, isAbsolute, join } from 'node:path'
import { useEffect, useState } from 'react'
import { Detail, closeMainWindow, showToast, Toast } from '@raycast/api'
import { findScripts } from './discover'
import { runScript, lastLine } from './run'
import type { ScriptCommand } from '@openray/script-discovery'

/** Image icons may be relative to the script's own folder; emoji and
 * absolute paths pass through as-is — matches native
 * `ScriptCommandProvider::commands()`'s icon-resolution exactly. */
function resolveIcon(script: ScriptCommand): string | undefined {
  if (!script.icon) return undefined
  if (script.icon.includes('.') && !isAbsolute(script.icon)) {
    return join(dirname(script.path), script.icon)
  }
  return script.icon
}

export default async function listRootCommands() {
  const scripts = await findScripts()
  return scripts.map((script) => ({
    id: script.path,
    title: script.title,
    subtitle: script.packageName ?? script.description,
    icon: resolveIcon(script),
    keywords: script.packageName ? [script.packageName] : [],
    // Optional-only arguments shouldn't force the prompt; the script
    // runs fine without them.
    requiresArgument: script.arguments.length > 0 && !script.arguments[0].optional,
    // Parsed but never enforced by native — enforcing it here is a
    // deliberate fidelity improvement, not scope creep (see metadata.ts).
    needsConfirm: script.needsConfirmation,
    // fullOutput activates through the `view` export below (mounted by
    // `runner.ts`'s `runRootCommandView`, T20) instead of running
    // headless through `execute` — every other mode stays headless.
    opensView: script.mode === 'fullOutput',
  }))
}

/** Headless activation — compact/inline (toast) and silent (background,
 * log-only on failure). `fullOutput` should never reach this: a row
 * with `opensView: true` is routed to the `view` export's mount instead
 * (see `extension_commands::launch_root_command`, T20). Left as a
 * no-op here rather than silently buffering and discarding output if
 * that routing is ever bypassed. */
export async function execute(id: string, argument?: string): Promise<void> {
  const scripts = await findScripts()
  const script = scripts.find((s) => s.path === id)
  if (!script) return

  if (script.mode === 'silent') {
    await closeMainWindow()
    const result = await runScript(script, argument)
    if (!result.success) {
      console.error(`script command '${script.title}' failed: ${lastLine(result.stderr) ?? result.error ?? ''}`)
    }
    return
  }

  if (script.mode === 'compact' || script.mode === 'inline') {
    const result = await runScript(script, argument)
    const message = result.success ? lastLine(result.stdout) : (lastLine(result.stderr) ?? lastLine(result.stdout) ?? result.error)
    await showToast({ style: result.success ? Toast.Style.Success : Toast.Style.Failure, title: script.title, message })
  }
}

interface ViewProps {
  id: string
  argument?: string
}

/** Mounted by `runner.ts`'s `runRootCommandView` for a `fullOutput`
 * script — updates its Detail's markdown as stdout/stderr chunks arrive
 * (a live `ui.commit` per state change, the same mechanism any other
 * mounted command's re-renders already produce), landing on the exact
 * same final stdout-then-stderr text native's own buffered
 * `SCRIPT_OUTPUT_EVENT` shows. */
export function view({ id, argument }: ViewProps) {
  const [title, setTitle] = useState('Script')
  const [stdout, setStdout] = useState('')
  const [stderr, setStderr] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const scripts = await findScripts()
        const script = scripts.find((s) => s.path === id)
        if (!script) {
          if (!cancelled) {
            setNotFound(true)
            setIsLoading(false)
          }
          return
        }
        if (!cancelled) setTitle(script.title)

        const result = await runScript(script, argument, {
          onData: (chunk) => {
            if (cancelled) return
            if (chunk.stdout) setStdout((prev) => prev + chunk.stdout)
            if (chunk.stderr) setStderr((prev) => prev + chunk.stderr)
          },
        })
        if (cancelled) return

        setStdout(result.stdout)
        setStderr(result.error ?? result.stderr)
        setFailed(!result.success)
        setIsLoading(false)
      } catch (error) {
        if (!cancelled) {
          setStdout(`INTERNAL ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
          setFailed(true)
          setIsLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [id, argument])

  const combined = [stdout, stderr].filter((text) => text.trim() !== '').join('\n')
  const markdown = notFound ? 'Script not found.' : combined ? `\`\`\`\n${combined}\n\`\`\`` : isLoading ? 'Running…' : 'No output'

  return (
    <Detail
      navigationTitle={title}
      isLoading={isLoading}
      markdown={markdown}
      metadata={
        !isLoading && !notFound ? (
          <Detail.Metadata>
            <Detail.Metadata.Label title="Status" text={failed ? 'Failed' : 'Success'} />
          </Detail.Metadata>
        ) : undefined
      }
    />
  )
}
