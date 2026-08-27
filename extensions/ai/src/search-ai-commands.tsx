import { useEffect, useRef, useState } from 'react'
import { List, ActionPanel, Action, Form, Detail, useNavigation, Clipboard } from '@raycast/api'
import { argumentSpecs } from '@openray/placeholders'
import * as storage from './storage'
import type { CommandRecord } from './storage'
import * as engine from './engine'
import { getAiSettings } from './settings'
import { commandPromptRequiresArgument, expandCommandPrompt } from './commandPrompt'
import { fetchWebpageText } from './webpage'

const STREAM_FLUSH_MS = 50

/** Runs `command`, streaming its output into a pushed `Detail` (for
 *  `outputMode: "view"`) or pasting the finished result into the
 *  previously-focused app (`outputMode: "replace"`) — matches native
 *  `api::ai::ai_run_command`/`engine::run_command`. */
function CommandRunView({ command, argument, namedArguments, webpageUrl }: { command: CommandRecord; argument?: string; namedArguments: Record<string, string>; webpageUrl?: string }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const buffer = useRef('')
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        let prompt = command.prompt
        if (prompt.includes('{webpage}')) {
          const url = webpageUrl ?? argument
          if (!url) throw new Error('parse: this command needs a URL for {webpage} but none was given')
          const webpage = await fetchWebpageText(url)
          prompt = prompt.replace('{webpage}', webpage)
        }
        const expanded = await expandCommandPrompt(prompt, argument, namedArguments)
        const settings = await getAiSettings()
        const model = command.model || settings.aiDefaultModel

        timer.current = setInterval(() => {
          if (!cancelled) setText(buffer.current)
        }, STREAM_FLUSH_MS)
        const finalText = await engine.runCommand(expanded, model, (delta) => {
          buffer.current += delta
        })
        if (cancelled) return
        setText(finalText)
        setDone(true)
        if (command.outputMode === 'replace') {
          await Clipboard.paste(finalText)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (timer.current) clearInterval(timer.current)
      }
    })()
    return () => {
      cancelled = true
      if (timer.current) clearInterval(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (command.outputMode === 'replace' && !error) {
    return <Detail markdown={done ? 'Pasted into the previous app.' : 'Thinking…'} navigationTitle={command.name} isLoading={!done} />
  }
  return (
    <Detail
      markdown={error ? `**Error:** ${error}` : text || 'Thinking…'}
      navigationTitle={command.name}
      isLoading={!done && !error}
      actions={
        text && (
          <ActionPanel>
            <Action.CopyToClipboard title="Copy" content={text} />
          </ActionPanel>
        )
      }
    />
  )
}

function ArgumentCaptureForm({ command, onSubmit }: { command: CommandRecord; onSubmit: (argument: string | undefined, named: Record<string, string>, webpageUrl: string | undefined) => void }) {
  const specs = argumentSpecs(command.prompt)
  const needsWebpage = command.prompt.includes('{webpage}')
  const [values, setValues] = useState<Record<string, string>>({})
  const [webpageUrl, setWebpageUrl] = useState('')

  return (
    <Form
      navigationTitle={command.name}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Run"
            onSubmit={() => {
              const named: Record<string, string> = {}
              let argument: string | undefined
              for (const spec of specs) {
                const value = values[spec.name ?? '__unnamed'] ?? spec.default ?? ''
                if (spec.name === null) argument = value
                else named[spec.name] = value
              }
              onSubmit(argument, named, needsWebpage ? webpageUrl || argument : undefined)
            }}
          />
        </ActionPanel>
      }
    >
      {needsWebpage && <Form.TextField id="__webpage" title="Webpage URL" placeholder="example.com" value={webpageUrl} onChange={setWebpageUrl} />}
      {specs.map((spec) => (
        <Form.TextField
          key={spec.name ?? '__unnamed'}
          id={spec.name ?? '__unnamed'}
          title={spec.name ?? 'Argument'}
          placeholder={spec.default ?? undefined}
          value={values[spec.name ?? '__unnamed'] ?? ''}
          onChange={(value) => setValues((prev) => ({ ...prev, [spec.name ?? '__unnamed']: value }))}
        />
      ))}
    </Form>
  )
}

export function runAiCommand(command: CommandRecord, push: (element: React.ReactElement) => void): void {
  if (commandPromptRequiresArgument(command.prompt)) {
    push(<ArgumentCaptureForm command={command} onSubmit={(argument, named, webpageUrl) => push(<CommandRunView command={command} argument={argument} namedArguments={named} webpageUrl={webpageUrl} />)} />)
  } else {
    push(<CommandRunView command={command} namedArguments={{}} />)
  }
}

export default function SearchAiCommandsCommand() {
  const [commands, setCommands] = useState<CommandRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const { push } = useNavigation()

  useEffect(() => {
    void storage.seedBuiltinCommands().then(() =>
      storage.listCommands().then((list) => {
        setCommands(list)
        setIsLoading(false)
      }),
    )
  }, [])

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search AI commands…" navigationTitle="Search AI Commands">
      {commands.map((command) => (
        <List.Item
          key={command.id}
          id={command.id}
          title={command.name}
          subtitle={command.builtin ? 'Built-in' : 'AI Command'}
          actions={
            <ActionPanel>
              <Action title="Run" onAction={() => runAiCommand(command, push)} />
              {!command.builtin && (
                <Action
                  title="Delete"
                  shortcut={{ modifiers: ['cmd'], key: 'backspace' }}
                  onAction={() => void storage.deleteCommand(command.id).then(() => storage.listCommands()).then(setCommands)}
                />
              )}
            </ActionPanel>
          }
        />
      ))}
      {commands.length === 0 && !isLoading && <List.EmptyView title="No AI commands" description="Create one with Create AI Command." />}
    </List>
  )
}
