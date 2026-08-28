import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionManifest } from '@openray/protocol'
import { buildExtensionInPlace, dependencySignature, readRawManifest } from './builder'
import { log } from './rpc'

/**
 * Coalescing window for filesystem events. An editor "save" is rarely one
 * event — atomic-rename saves (vim, and every editor with a write-to-temp
 * strategy) produce a rename plus one or more change events, and a
 * formatter running on save adds another round. Rebuilding per event would
 * mean three or four esbuild passes and three or four relaunches of the
 * command the author is looking at, for a single Cmd-S.
 */
const DEBOUNCE_MS = 120

export interface DevBuildResult {
  extensionId: string
  dir: string
  /** Command names built this pass (all of the manifest's — see `rebuild`). */
  commands: string[]
  /** True when `package.json` itself changed, so the platform must re-register. */
  manifestChanged: boolean
  /** The re-read manifest, present only when `manifestChanged`. */
  manifest?: ExtensionManifest
  /** Per-command build failures, in `buildExtensionInPlace`'s `"<command>: <error>"` shape. */
  errors: string[]
  durationMs: number
}

/** Emits a `extension.devBuild` notification to the platform. */
export type DevNotifier = (result: DevBuildResult) => void

interface DevSession {
  id: string
  dir: string
  watchers: FSWatcher[]
  /** Last-seen dependency blocks, for the "author added a dep" check. */
  dependencies: string
  /** Set while a rebuild is in flight, so events that land mid-build queue exactly one follow-up. */
  building: boolean
  /** Pending coalesced work: whether anything changed, and whether the manifest was part of it. */
  pending: { manifest: boolean } | null
  timer: NodeJS.Timeout | null
  stopped: boolean
}

/**
 * Active dev sessions, keyed by extension id. Keyed by id rather than
 * directory so `developStop` needs nothing the platform doesn't already
 * have (the extension id is what the registry, the palette, and every
 * Settings row are keyed by), and so developing two checkouts of the same
 * extension is a conflict this map catches rather than two watchers
 * fighting over one registration.
 */
const sessions = new Map<string, DevSession>()

/**
 * Starts (or restarts) dev mode for an extension directory: builds it in
 * place, then watches `src/` and `package.json` for changes.
 *
 * The initial build is awaited and its errors returned to the caller, so a
 * folder that doesn't compile still *starts* dev mode — the author sees
 * the error in the UI and fixes it with the watcher already running, which
 * is the whole point. Only a manifest that can't be read at all throws,
 * since without one there's no extension id to key anything by.
 */
export async function developStart(dir: string, notify: DevNotifier): Promise<{
  id: string
  manifest: ExtensionManifest
  dir: string
  buildErrors: string[]
}> {
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(`${dir} does not look like an extension directory (no package.json)`)
  }

  const built = await buildExtensionInPlace(dir)

  // Replacing an existing session for the same id (re-running `develop` on
  // a folder already being watched) tears the old watchers down rather
  // than leaking them — every rebuild would otherwise fire twice.
  developStop(built.id)

  const session: DevSession = {
    id: built.id,
    dir,
    watchers: [],
    dependencies: dependencySignature(await readRawManifest(dir)),
    building: false,
    pending: null,
    timer: null,
    stopped: false,
  }
  sessions.set(built.id, session)

  const schedule = (manifestChanged: boolean) => {
    if (session.stopped) return
    session.pending = { manifest: (session.pending?.manifest ?? false) || manifestChanged }
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      session.timer = null
      void drain(session, notify)
    }, DEBOUNCE_MS)
  }

  const srcDir = join(dir, 'src')
  if (existsSync(srcDir)) {
    // `recursive` so nested source folders are covered; Node supports it
    // on all three desktop platforms as of v20, which is the floor the
    // bundled sidecar runtime already sets.
    session.watchers.push(watchSafely(srcDir, { recursive: true }, () => schedule(false)))
  }
  // The manifest is watched through its *directory*, not the file: an
  // atomic-rename save replaces the inode, and a file watcher bound to the
  // old one stops reporting anything afterwards — silently, which is the
  // worst failure mode for a watcher.
  session.watchers.push(
    watchSafely(dir, {}, (filename) => {
      if (filename === 'package.json') schedule(true)
    }),
  )

  log(`develop: watching ${dir} (${built.id})`)
  return { id: built.id, manifest: built.manifest, dir, buildErrors: built.buildErrors }
}

/** Stops watching; returns whether a session was actually running. */
export function developStop(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  session.stopped = true
  if (session.timer) clearTimeout(session.timer)
  for (const watcher of session.watchers) watcher.close()
  sessions.delete(id)
  log(`develop: stopped watching ${session.dir} (${id})`)
  return true
}

export function developList(): { id: string; dir: string }[] {
  return [...sessions.values()].map((session) => ({ id: session.id, dir: session.dir }))
}

/**
 * `fs.watch` throws synchronously for an unreadable path and emits
 * `error` asynchronously if the directory disappears later (the author
 * deleting or moving their folder mid-session). Neither should take the
 * host down — dev mode degrading to "no longer watching" is survivable,
 * an unhandled `error` event on an EventEmitter is not.
 */
function watchSafely(path: string, options: { recursive?: boolean }, onChange: (filename: string | null) => void): FSWatcher {
  const watcher = watch(path, options, (_event, filename) => {
    onChange(typeof filename === 'string' ? filename : null)
  })
  watcher.on('error', (error) => {
    log(`develop: watcher for ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  return watcher
}

/**
 * Runs one rebuild for whatever has accumulated since the last one, then
 * immediately runs again if more changes landed while it was building.
 * The `building` guard is what makes concurrent esbuild passes over the
 * same output directory impossible — two passes writing the same
 * `.openray/build/<command>.js` could otherwise interleave and leave a
 * half-written bundle that fails to load with an error pointing nowhere
 * near the author's actual mistake.
 */
async function drain(session: DevSession, notify: DevNotifier): Promise<void> {
  if (session.stopped || session.building) return
  const pending = session.pending
  if (!pending) return
  session.pending = null
  session.building = true

  try {
    const started = Date.now()
    let forceInstall = false
    if (pending.manifest) {
      // A dependency added to the manifest has to be installed before the
      // rebuild, or the very next build fails on an import the author just
      // legitimately wrote.
      try {
        const dependencies = dependencySignature(await readRawManifest(session.dir))
        forceInstall = dependencies !== session.dependencies
        session.dependencies = dependencies
      } catch (error) {
        // A manifest saved mid-edit is routinely unparseable for a moment.
        // Report it as a build error rather than throwing away the session.
        notify({
          extensionId: session.id,
          dir: session.dir,
          commands: [],
          manifestChanged: true,
          errors: [`package.json: ${error instanceof Error ? error.message : String(error)}`],
          durationMs: Date.now() - started,
        })
        return
      }
    }

    const built = await buildExtensionInPlace(session.dir, { forceInstall })
    if (session.stopped) return
    notify({
      extensionId: session.id,
      dir: session.dir,
      commands: built.manifest.commands.map((command) => command.name),
      manifestChanged: pending.manifest,
      ...(pending.manifest ? { manifest: built.manifest } : {}),
      errors: built.buildErrors,
      durationMs: Date.now() - started,
    })
  } catch (error) {
    notify({
      extensionId: session.id,
      dir: session.dir,
      commands: [],
      manifestChanged: pending.manifest,
      errors: [error instanceof Error ? error.message : String(error)],
      durationMs: 0,
    })
  } finally {
    session.building = false
    if (session.pending && !session.stopped) void drain(session, notify)
  }
}
