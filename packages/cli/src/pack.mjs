import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Packing goes through the extension host's own pipeline
 * (`dist/cli-api.cjs`), not a reimplementation. A registry that packed
 * differently from how the app builds would eventually publish archives the
 * app can't run — one pipeline is the whole reason this is a thin wrapper.
 */
function pipeline() {
  // Loading the pipeline pulls in the api-shim so the capability check can
  // read its export list; without this the CLI prints a warning for every
  // unimplemented API on every pack, none of which the packer called.
  process.env.OPENRAY_SHIM_QUIET = '1'
  try {
    return require('@openray/extension-host/dist/cli-api.cjs')
  } catch {
    throw new Error(
      'Could not load the OpenRay build pipeline.\nRun `pnpm --filter @openray/extension-host build` first.',
    )
  }
}

export async function pack(dir, outDir) {
  const { packExtension } = pipeline()
  const source = resolve(dir)
  const out = resolve(outDir ?? join(process.cwd(), 'dist'))
  const packed = await packExtension(source, out, sourceCommit())
  process.stdout.write(`packed ${packed.file}\n`)
  process.stdout.write(`  sha256 ${packed.sha256}\n`)
  process.stdout.write(`  uses   ${packed.usedApis.join(', ') || '(no API imports)'}\n`)
  return packed
}

/**
 * Packs several extensions and writes the `index.json` catalog beside them
 * — everything a registry is. Publishing then means serving `outDir` from
 * any static host.
 */
export async function publish(dirs, outDir) {
  const { packExtension } = pipeline()
  const out = resolve(outDir ?? join(process.cwd(), 'dist'))
  mkdirSync(out, { recursive: true })

  const entries = []
  const failures = []
  for (const dir of dirs) {
    const source = resolve(dir)
    if (!existsSync(join(source, 'package.json'))) continue
    try {
      const packed = await packExtension(source, out, sourceCommit())
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf-8'))
      const entry = {
        name: packed.id,
        title: manifest.title ?? packed.id,
        version: packed.version,
        file: packed.file,
        sha256: packed.sha256,
      }
      // The command list, not just a count: the Store's detail view lists
      // them by name and description, and the row's tooltip only needs
      // `.length`. Trimmed to the three fields that get displayed so a
      // catalog doesn't carry preference schemas nobody reads.
      if (Array.isArray(manifest.commands)) {
        entry.commands = manifest.commands.map((command) => ({
          name: command.name,
          title: command.title ?? command.name,
          ...(command.description ? { description: command.description } : {}),
        }))
      }
      if (manifest.description) entry.description = manifest.description
      if (manifest.author) entry.author = manifest.author
      if (Array.isArray(manifest.categories)) entry.categories = manifest.categories
      if (Array.isArray(manifest.platforms)) entry.platforms = manifest.platforms

      // Screenshots follow Raycast's own convention: a `metadata/` folder
      // beside the manifest. They are copied out rather than packed into the
      // archive because they are big — a single Raycast extension's are
      // routinely 5 MB — and nobody should download them to *install*
      // something. Sorted so the order is the author's numbering
      // (`name-1.png`, `name-2.png`), not the filesystem's.
      const metadataDir = join(source, 'metadata')
      if (existsSync(metadataDir)) {
        const shots = readdirSync(metadataDir)
          .filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        // Renumbered rather than prefixed: Raycast's convention already names
        // each file after the extension (`linear-1.png`), so keeping the
        // original would produce `foo-metadata-foo-1.png`. The catalog only
        // needs a name unique within the registry, and position is the only
        // thing the order depends on.
        const copied = []
        shots.forEach((file, index) => {
          const name = `${packed.id}-metadata-${index + 1}${extname(file).toLowerCase()}`
          copyFileSync(join(metadataDir, file), join(out, name))
          copied.push(name)
        })
        if (copied.length > 0) entry.screenshots = copied
      }

      // README and icon are copied out so a catalog can render a rich
      // listing without unpacking every archive.
      const readme = join(source, 'README.md')
      if (existsSync(readme)) {
        const name = `${packed.id}-README.md`
        copyFileSync(readme, join(out, name))
        entry.readme = name
      }
      if (typeof manifest.icon === 'string' && manifest.icon.includes('.') && existsSync(join(source, manifest.icon))) {
        const name = `${packed.id}-icon${extname(manifest.icon)}`
        copyFileSync(join(source, manifest.icon), join(out, name))
        entry.icon = name
      }
      entries.push(entry)
      process.stdout.write(`packed ${packed.file}\n`)
    } catch (error) {
      // One extension failing must not abandon a whole catalog build — the
      // packer reports and moves on, and CI fails at the end with the list.
      failures.push(`${basename(source)}: ${error instanceof Error ? error.message : String(error)}`)
      process.stderr.write(`skipped ${basename(source)}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  // Staged inside `out` and renamed: a same-directory rename is atomic, so
  // a catalog is never served half-written, and two concurrent publishes
  // can't interleave.
  const catalog = { formatVersion: 1, name: catalogName(), extensions: entries }
  const staged = join(out, `.tmp-${randomUUID()}-index.json`)
  writeFileSync(staged, JSON.stringify(catalog, null, 2))
  renameSync(staged, join(out, 'index.json'))
  process.stdout.write(`\nwrote index.json (${entries.length} extension${entries.length === 1 ? '' : 's'}) to ${out}\n`)

  if (failures.length > 0) {
    throw new Error(`${failures.length} extension(s) could not be packed:\n  ${failures.join('\n  ')}`)
  }
  return catalog
}

function catalogName() {
  const path = join(process.cwd(), 'package.json')
  if (!existsSync(path)) return 'OpenRay Extensions'
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf-8'))
    return manifest.registryName ?? manifest.name ?? 'OpenRay Extensions'
  } catch {
    return 'OpenRay Extensions'
  }
}

/**
 * Records which commit an archive was built from, so a published archive
 * can always be traced back to source. `GITHUB_SHA` is set by Actions,
 * which is where a registry's packing actually happens; a local pack simply
 * doesn't record one.
 */
function sourceCommit() {
  return process.env.GITHUB_SHA ? { sourceCommit: process.env.GITHUB_SHA } : {}
}
