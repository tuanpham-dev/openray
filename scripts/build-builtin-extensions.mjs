// Builds every first-party extension under extensions/ to
// extensions/<name>/.openray/build/, using the exact same builder
// (buildCommand/readManifest, packages/extension-host's dist/builder.cjs)
// user-installed extensions go through — no separate build logic to drift
// out of sync with. Unlike a user install, these are pnpm workspace
// members: their deps are already resolved by the root `pnpm install`, so
// this builds each command in place rather than copying the extension
// anywhere first.
//
// Run after `pnpm --filter @openray/extension-host build` (produces
// dist/builder.cjs) and before the Rust build — `lib.rs`'s startup
// registration reads each extension's already-built `.openray/build/`
// directory, it doesn't build anything itself.

import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const extensionsRoot = join(root, 'extensions')
const builderPath = join(root, 'packages', 'extension-host', 'dist', 'builder.cjs')

if (!existsSync(builderPath)) {
  console.error(`${builderPath} not found — run "pnpm --filter @openray/extension-host build" first`)
  process.exit(1)
}

const { buildCommand, buildExportEntry, readManifest } = await import(builderPath)

if (!existsSync(extensionsRoot)) {
  console.log('no extensions/ directory — nothing to build')
  process.exit(0)
}

const entries = await readdir(extensionsRoot, { withFileTypes: true })
const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)

let failed = false
for (const name of dirs) {
  const extensionDir = join(extensionsRoot, name)
  if (!existsSync(join(extensionDir, 'package.json'))) continue

  const manifest = await readManifest(extensionDir)
  console.log(`building ${manifest.name} (${manifest.commands.length} command${manifest.commands.length === 1 ? '' : 's'})`)

  for (const command of manifest.commands) {
    const error = await buildCommand(extensionDir, command.name)
    if (error) {
      failed = true
      console.error(`  ${manifest.name}:${command.name} failed: ${error}`)
    } else {
      console.log(`  ${manifest.name}:${command.name} OK`)
    }
  }

  const exportError = await buildExportEntry(extensionDir, manifest)
  if (exportError) {
    failed = true
    console.error(`  ${manifest.name} ${exportError}`)
  } else if (manifest.export) {
    console.log(`  ${manifest.name}:<export hooks> OK`)
  }
}

if (failed) process.exit(1)
