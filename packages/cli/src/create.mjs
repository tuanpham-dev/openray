import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { TEMPLATES, scaffoldFiles } from '@openray/extension-template'

/**
 * Scaffolds an extension and leaves it ready for `npm run dev`, which is
 * the loop this CLI exists to make ordinary: create, develop, save, see it
 * in the launcher.
 *
 * The scaffold comes from `@openray/extension-template`, shared with the
 * in-app "Create Extension" command — two scaffolds would diverge the first
 * time either was touched.
 */
export async function create(dir, templateId) {
  let target = dir
  let template = templateId

  const interactive = !target || !template
  const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null
  try {
    if (!target) target = (await prompt.question('Extension folder name: ')).trim()
    if (!target) throw new Error('a folder name is required')

    if (!template) {
      process.stdout.write('\nTemplates:\n')
      TEMPLATES.forEach((entry, index) => {
        process.stdout.write(`  ${index + 1}. ${entry.title} — ${entry.description}\n`)
      })
      const answer = (await prompt.question(`\nTemplate [1-${TEMPLATES.length}, default 1]: `)).trim()
      const index = answer ? Number(answer) - 1 : 0
      template = TEMPLATES[index]?.id ?? TEMPLATES[0].id
    }
  } finally {
    prompt?.close()
  }

  const path = resolve(target)
  if (existsSync(path)) throw new Error(`${path} already exists`)

  // The folder name is the extension's identity, so it is also the default
  // display name — `openray create my-notes` should not produce something
  // called "My Extension".
  const { files, id } = scaffoldFiles({ name: basename(path), template })

  mkdirSync(path, { recursive: true })
  for (const [relativePath, contents] of Object.entries(files)) {
    const file = join(path, relativePath)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }

  process.stdout.write(`\nCreated ${path} (${id})\n\n`)
  process.stdout.write('Next:\n')
  process.stdout.write(`  cd ${target}\n`)
  process.stdout.write('  npm install\n')
  process.stdout.write('  npm run dev\n')
}
