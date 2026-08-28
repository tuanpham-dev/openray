import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

/**
 * OpenRay's config directory: `~/.config/openray` on Linux,
 * `~/Library/Application Support/openray` on macOS, `%APPDATA%\openray` on
 * Windows — matching `infrastructure::paths::config_dir`.
 */
function configDir() {
  const home = homedir()
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'openray')
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'openray')
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'openray')
}

/**
 * Where the running app listens.
 *
 * Read from a pointer file the app writes rather than recomputed here: the
 * socket lives in the app *data* directory, whose name is derived from the
 * bundle identifier by Tauri's own rules, and reimplementing that here
 * would be a second source of truth that breaks silently the day either
 * changes. The config directory below is the stable, documented path both
 * sides can agree on.
 */
function socketPath() {
  const pointer = join(configDir(), 'control-socket')
  if (existsSync(pointer)) {
    const recorded = readFileSync(pointer, 'utf-8').trim()
    if (recorded) return recorded
  }
  return pointer
}

/**
 * A connection to the running app: newline-delimited JSON in both
 * directions, requests answered by id, events pushed unprompted.
 *
 * Everything this speaks to is already implemented in the app — the CLI
 * builds nothing itself, so a dev build started from a terminal and one
 * started from Settings are the same build.
 */
export class ControlClient {
  #socket
  #pending = new Map()
  #nextId = 1
  #onEvent

  constructor(socket, onEvent) {
    this.#socket = socket
    this.#onEvent = onEvent
    const lines = createInterface({ input: socket })
    lines.on('line', (line) => {
      if (!line.trim()) return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.event) {
        this.#onEvent?.(message)
        return
      }
      const waiter = this.#pending.get(message.id)
      if (!waiter) return
      this.#pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error))
      else waiter.resolve(message.result)
    })
  }

  static async connect(onEvent, path = socketPath()) {
    if (!existsSync(path)) {
      throw new Error(
        `OpenRay does not appear to be running (no control socket at ${path}).\nStart OpenRay, then run this again.`,
      )
    }
    const socket = await new Promise((resolve, reject) => {
      const attempt = connect(path)
      attempt.once('connect', () => resolve(attempt))
      attempt.once('error', (error) =>
        reject(
          new Error(
            error.code === 'ECONNREFUSED'
              ? `Found a stale control socket at ${path}. Is OpenRay running?`
              : `Could not connect to OpenRay: ${error.message}`,
          ),
        ),
      )
    })
    return new ControlClient(socket, onEvent)
  }

  call(method, params = {}) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  close() {
    this.#socket.end()
  }
}
