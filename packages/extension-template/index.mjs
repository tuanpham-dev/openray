/**
 * The extension scaffold, shared by `openray create` and the in-app
 * "Create Extension" command.
 *
 * Both exist because both are worth having — a terminal-first author wants
 * a CLI, and someone who has never opened one should still be able to make
 * an extension from the launcher. What they must not be is two scaffolds:
 * the moment they diverge, one of them starts producing extensions that
 * don't match the documentation.
 *
 * Plain ESM JavaScript rather than TypeScript so both consumers can use it
 * as-is — the CLI imports it directly with no build step, and esbuild
 * bundles it into the extension.
 */

/**
 * The starting points on offer, named after Raycast's own so an author who
 * has used that tool recognizes them ("Show Detail", "Submit Form", …).
 *
 * Two of Raycast's nine are deliberately absent rather than scaffolded
 * broken: **Menu Bar Extra** (the shim's `MenuBarExtra` is still a logging
 * stub, so the template would mount and do nothing) and **AI** (the
 * extension-facing `AI` API is in the shim's unsupported set). Offering a
 * template that cannot run is a worse first experience than offering one
 * fewer.
 *
 * @type {{ id: string, title: string, description: string, mode: string }[]}
 */
export const TEMPLATES = [
  { id: 'list', title: 'Show List', description: 'A static list with icons, subtitles, and accessories', mode: 'view' },
  { id: 'detail', title: 'Show Detail', description: 'A single markdown view', mode: 'view' },
  { id: 'list-detail', title: 'Show List and Detail', description: 'A list whose selection shows a detail pane', mode: 'view' },
  { id: 'typeahead', title: 'Show Typeahead Results', description: 'A searchable list that loads results as you type', mode: 'view' },
  { id: 'form', title: 'Submit Form', description: 'Fields with a submit action', mode: 'view' },
  { id: 'grid', title: 'Show Grid', description: 'A grid of items', mode: 'view' },
  { id: 'no-view', title: 'Run Script', description: 'Runs and shows a HUD, with no UI', mode: 'no-view' },
]

/**
 * Turns a folder-shaped name into a display title: `my-notes` → `My Notes`.
 * A name that already contains spaces or capitals is left alone, so
 * "GitHub Issues" survives intact rather than becoming "Github Issues".
 */
export function toDisplayTitle(name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed || /[A-Z\s]/.test(trimmed)) return trimmed
  return trimmed
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Turns a human name into a manifest id: lowercase, hyphens, nothing else. */
export function toExtensionId(name) {
  const id = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return id || 'my-extension'
}

const COMMAND_SOURCE = {
  list: `import { Action, ActionPanel, Icon, List } from '@raycast/api'

const ITEMS = [
  { id: '1', title: 'First item', subtitle: 'Edit src/{{command}}.tsx and save', accessory: 'One' },
  { id: '2', title: 'Second item', subtitle: 'This list reloads as you type', accessory: 'Two' },
]

export default function Command() {
  return (
    <List searchBarPlaceholder="Search…">
      {ITEMS.map((item) => (
        <List.Item
          key={item.id}
          icon={Icon.Circle}
          title={item.title}
          subtitle={item.subtitle}
          accessories={[{ text: item.accessory }]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title="Copy Title" content={item.title} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
`,
  detail: `import { Detail } from '@raycast/api'

const MARKDOWN = \`# {{title}}

Edit \\\`src/{{command}}.tsx\\\` and save — this reloads as you type.
\`

export default function Command() {
  return <Detail markdown={MARKDOWN} />
}
`,
  'list-detail': `import { List } from '@raycast/api'

const ITEMS = [
  { id: '1', title: 'First item', body: '# First item\\n\\nSelect another item to see its detail.' },
  { id: '2', title: 'Second item', body: '# Second item\\n\\nEdit src/{{command}}.tsx and save.' },
]

export default function Command() {
  return (
    <List isShowingDetail searchBarPlaceholder="Search…">
      {ITEMS.map((item) => (
        <List.Item key={item.id} title={item.title} detail={<List.Item.Detail markdown={item.body} />} />
      ))}
    </List>
  )
}
`,
  typeahead: `import { useState } from 'react'
import { Action, ActionPanel, List } from '@raycast/api'
import { usePromise } from '@raycast/utils'

// \`usePromise\` re-runs whenever its arguments change, which is what makes
// this a typeahead: every keystroke is a new search.
export default function Command() {
  const [query, setQuery] = useState('')
  const { data, isLoading } = usePromise(
    async (search: string) => {
      if (!search) return []
      const response = await fetch(\`https://registry.npmjs.org/-/v1/search?text=\${encodeURIComponent(search)}&size=20\`)
      if (!response.ok) throw new Error(\`npm search failed: \${response.status}\`)
      const body = (await response.json()) as { objects: { package: { name: string; description?: string; links?: { npm?: string } } }[] }
      return body.objects.map((entry) => entry.package)
    },
    [query],
  )

  return (
    <List isLoading={isLoading} onSearchTextChange={setQuery} searchBarPlaceholder="Search npm…" throttle>
      {(data ?? []).map((pkg) => (
        <List.Item
          key={pkg.name}
          title={pkg.name}
          subtitle={pkg.description ?? ''}
          actions={
            <ActionPanel>
              {pkg.links?.npm && <Action.OpenInBrowser url={pkg.links.npm} />}
              <Action.CopyToClipboard title="Copy Name" content={pkg.name} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
`,
  form: `import { Action, ActionPanel, Form, showToast, Toast } from '@raycast/api'

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Submit"
            onSubmit={(values) => {
              void showToast({ style: Toast.Style.Success, title: 'Submitted', message: String(values.name ?? '') })
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" placeholder="Type something" />
      <Form.TextArea id="notes" title="Notes" />
      <Form.Separator />
      <Form.Checkbox id="confirm" label="I mean it" />
    </Form>
  )
}
`,
  grid: `import { Grid } from '@raycast/api'

export default function Command() {
  return (
    <Grid searchBarPlaceholder="Search…">
      <Grid.Item title="First item" content="🚀" />
      <Grid.Item title="Second item" content="✨" />
    </Grid>
  )
}
`,
  'no-view': `import { showHUD } from '@raycast/api'

export default async function Command() {
  await showHUD('Hello from {{title}}')
}
`,
}

const README = `# {{title}}

{{description}}

## Developing

\`\`\`sh
npm install
npm run dev
\`\`\`

\`npm run dev\` asks the running OpenRay to build this folder in place and
watch it. Your commands appear in the launcher straight away, and every
save rebuilds and reloads them — build errors show up in this terminal.

Types come from \`@raycast/api\`, which is a dev dependency only: at build
time OpenRay maps those imports onto its own compatible implementation, so
nothing from that package ends up in the bundle.

## Packaging

\`\`\`sh
npx openray pack     # dist/{{id}}-<version>.orx
\`\`\`

A directory of packed archives plus an \`index.json\` (see \`openray publish\`)
is a registry others can add.
`

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`

const GITIGNORE = `node_modules/
dist/
.openray/
`

function fill(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key) => values[key] ?? '')
}

/**
 * Builds the scaffold as a path → contents map, so callers can write it
 * however suits them (the CLI writes it directly; the in-app command wants
 * to check for collisions first).
 *
 * @param {{ name: string, description?: string, author?: string, template?: string, commandName?: string, categories?: string[] }} options
 * @returns {{ id: string, commandName: string, files: Record<string, string> }}
 */
export function scaffoldFiles(options) {
  const id = toExtensionId(options.name)
  const title = toDisplayTitle(options.name) || id
  const template = TEMPLATES.find((entry) => entry.id === options.template) ?? TEMPLATES[0]
  const commandName = toExtensionId(options.commandName ?? id)
  const description = String(options.description ?? '').trim() || `${title}, an OpenRay extension.`
  const values = { id, title, description, command: commandName }

  const manifest = {
    name: id,
    title,
    description,
    version: '1.0.0',
    ...(options.author ? { author: options.author } : {}),
    ...(options.categories?.length ? { categories: options.categories } : {}),
    commands: [
      {
        name: commandName,
        title,
        description,
        mode: template.mode,
      },
    ],
    scripts: { dev: 'openray develop' },
    devDependencies: {
      '@raycast/api': '^1.0.0',
      '@types/react': '^19.0.0',
      typescript: '^5.0.0',
    },
  }

  return {
    id,
    commandName,
    files: {
      'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'tsconfig.json': TSCONFIG,
      '.gitignore': GITIGNORE,
      'README.md': fill(README, values),
      [`src/${commandName}.tsx`]: fill(COMMAND_SOURCE[template.id] ?? COMMAND_SOURCE.list, values),
    },
  }
}
