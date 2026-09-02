import { useState } from 'react'
import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Action, ActionPanel, Clipboard, Form, Icon, open, popToRoot, showToast, Toast } from '@raycast/api'
import { developExtension } from '@openray/extras'
import { TEMPLATES, scaffoldFiles, toExtensionId } from '@openray/extension-template'

/**
 * Raycast's "Create Extension" flow, which is the shortest path from
 * "I want to build something" to a command that already runs: fill in a
 * form, get a folder, and — because OpenRay can build it in place — watch
 * it appear in the launcher without a terminal.
 *
 * The scaffold itself comes from `@openray/extension-template`, shared with
 * `openray create`. Two scaffolds would diverge the first time one of them
 * was updated, and then half the documentation would be wrong.
 */

/** `~/Developer` if it exists (macOS convention, common enough elsewhere),
 *  otherwise the home directory. */
function defaultLocation(): string {
  const preferred = join(homedir(), 'Developer')
  return existsSync(preferred) ? preferred : homedir()
}

function isAvailable(bin: string): boolean {
  return spawnSync('which', [bin]).status === 0
}

/**
 * Opens the new folder in an editor.
 *
 * Raycast's equivalent action is "Create and Open in Xcode", which is
 * macOS-only in a way that has no single Linux counterpart — so `$VISUAL`
 * / `$EDITOR` come first (the author has already said what they use),
 * then the GUI editors common enough to be worth guessing at. Follows the
 * same `$TERMINAL`-then-candidates shape `file-search` uses for terminals.
 */
function openInEditor(path: string): boolean {
  const candidates = [process.env.VISUAL, process.env.EDITOR, 'code', 'codium', 'zed', 'subl', 'gnome-text-editor'].filter(
    (bin): bin is string => Boolean(bin) && isAvailable(bin),
  )
  const editor = candidates[0]
  if (editor) {
    spawn(editor, [path], { detached: true, stdio: 'ignore' }).unref()
    return true
  }

  // The `which` candidates above only catch an editor whose CLI shim is
  // on PATH — VS Code, Cursor, Zed, and Sublime Text all ship that as an
  // opt-in "install shell command" step most users never run, so a
  // completely normal install (dragged straight into /Applications)
  // was invisible here even with the editor sitting right there. Same
  // problem `file-search`'s `openInTerminal` already hit and fixed for
  // Terminal/iTerm: check real `.app` bundles and launch via `open -a`
  // instead of guessing at PATH.
  if (process.platform === 'darwin') {
    const app = ['Visual Studio Code', 'Cursor', 'Zed', 'Sublime Text', 'TextMate', 'BBEdit'].find((name) =>
      existsSync(`/Applications/${name}.app`),
    )
    if (app) {
      spawn('open', ['-a', app, path], { detached: true, stdio: 'ignore' }).unref()
      return true
    }
  }

  return false
}

function expandHome(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/** What to do once the folder exists — the difference between the four
 *  actions in the panel, which are otherwise the same submit. */
type FollowUp = 'none' | 'editor' | 'folder' | 'copy-path'

interface FormValues {
  name: string
  description: string
  author: string
  categories: string
  location: string
  template: string
}

export default function Command() {
  const [creating, setCreating] = useState(false)
  const [nameError, setNameError] = useState<string | undefined>()
  const [locationError, setLocationError] = useState<string | undefined>()

  const submit = async (values: FormValues, followUp: FollowUp) => {
    const name = values.name?.trim() ?? ''
    if (!name) {
      setNameError('Required')
      return
    }
    const location = expandHome(values.location ?? '')
    if (!location || !isAbsolute(location)) {
      setLocationError('Enter an absolute folder path')
      return
    }

    const id = toExtensionId(name)
    const target = resolve(join(location, id))
    if (existsSync(target)) {
      setLocationError(`${target} already exists`)
      return
    }

    setCreating(true)
    try {
      const { files } = scaffoldFiles({
        name,
        description: values.description ?? '',
        author: values.author ?? '',
        // Raycast offers a tag picker here; the shim has no such field, so
        // a comma-separated list is the honest equivalent rather than a
        // fixed dropdown that would guess at someone's taxonomy.
        categories: (values.categories ?? '')
          .split(',')
          .map((category) => category.trim())
          .filter(Boolean),
        template: values.template ?? 'list',
      })

      // Written after every path is known: a half-written scaffold is
      // worse than none, and the collision check above is the only thing
      // standing between this and someone's existing folder.
      mkdirSync(target, { recursive: true })
      for (const [relativePath, contents] of Object.entries(files)) {
        const file = join(target, relativePath)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, contents)
      }

      // The part that makes this worth doing in-app rather than in a
      // terminal: the extension is built and watched immediately, so its
      // command is in the launcher before the toast fades.
      let live = true
      try {
        await developExtension(target)
      } catch (error) {
        live = false
        await showToast({
          style: Toast.Style.Failure,
          title: 'Created, but not started',
          message: error instanceof Error ? error.message : String(error),
        })
      }

      if (live) {
        await showToast({
          style: Toast.Style.Success,
          title: `Created ${name}`,
          message: 'Its command is in the launcher now — edit src/ and save to reload.',
        })
      }
      switch (followUp) {
        case 'editor':
          if (!openInEditor(target)) {
            await showToast({
              style: Toast.Style.Failure,
              title: 'No editor found',
              message: 'Set $EDITOR, or install one of code, codium, zed, subl.',
            })
            // Still better than leaving them with nothing to look at.
            await open(target)
          }
          break
        case 'folder':
          await open(target)
          break
        case 'copy-path':
          await Clipboard.copy(target)
          await showToast({ style: Toast.Style.Success, title: 'Copied folder path', message: target })
          break
        case 'none':
          break
      }
      await popToRoot()
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Could not create the extension',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <Form
      isLoading={creating}
      navigationTitle="Create Extension"
      actions={
        <ActionPanel>
          {/* The same four Raycast offers here, with its Xcode action
              replaced by the editor the author actually uses. */}
          <Action.SubmitForm
            title="Create Extension"
            icon={Icon.Plus}
            shortcut={{ modifiers: ['cmd'], key: 'enter' }}
            onSubmit={(values) => void submit(values as unknown as FormValues, 'none')}
          />
          <Action.SubmitForm
            title="Create and Open in Editor"
            icon={Icon.Code}
            shortcut={{ modifiers: ['cmd', 'shift'], key: 'enter' }}
            onSubmit={(values) => void submit(values as unknown as FormValues, 'editor')}
          />
          <Action.SubmitForm
            title="Create and Open Folder"
            icon={Icon.Folder}
            shortcut={{ modifiers: ['cmd', 'ctrl'], key: 'enter' }}
            onSubmit={(values) => void submit(values as unknown as FormValues, 'folder')}
          />
          <Action.SubmitForm
            title="Create and Copy Folder Path"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ['cmd', 'opt'], key: 'enter' }}
            onSubmit={(values) => void submit(values as unknown as FormValues, 'copy-path')}
          />
        </ActionPanel>
      }
    >
      <Form.Description text="Creates a folder, builds it, and starts watching it for changes." />
      <Form.TextField
        id="name"
        title="Name"
        placeholder="My Extension"
        error={nameError}
        onChange={() => setNameError(undefined)}
      />
      <Form.TextField id="description" title="Description" placeholder="What it does" />
      <Form.TextField id="author" title="Author" placeholder="Your name or handle" />
      <Form.TextField id="categories" title="Categories" placeholder="Productivity, Developer Tools" />
      <Form.TextField
        id="location"
        title="Location"
        defaultValue={defaultLocation()}
        placeholder="~/Developer"
        error={locationError}
        onChange={() => setLocationError(undefined)}
      />
      <Form.Dropdown id="template" title="Template" defaultValue="list">
        {TEMPLATES.map((template) => (
          <Form.Dropdown.Item key={template.id} value={template.id} title={`${template.title} — ${template.description}`} />
        ))}
      </Form.Dropdown>
    </Form>
  )
}
