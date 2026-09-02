import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { binaryExists } from './path'

// Fire-and-forget: several of these end the session (log out, shut down),
// and waiting on them would hang the sidecar for no benefit — the OS tool
// owns the outcome from here. Resolves once the child has actually started
// (mirroring native `Process::spawn()` returning `Ok` synchronously);
// rejects on spawn failure (e.g. ENOENT) the same way a synchronous spawn
// error does natively.
function spawnDetached(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function lockScreen(): Promise<void> {
  // `loginctl lock-session` depends on a lock handler being registered
  // for the session; on setups without one it silently no-ops. Try it
  // first, and if it doesn't exit cleanly, fall back to
  // `xdg-screensaver lock`, which works directly against any X11
  // screensaver-compatible locker.
  const attempt = spawnSync('loginctl', ['lock-session'])
  if (attempt.status === 0) return
  await spawnDetached('xdg-screensaver', ['lock'])
}

async function logOut(): Promise<void> {
  if (binaryExists('xfce4-session-logout')) {
    await spawnDetached('xfce4-session-logout', ['--logout'])
    return
  }
  const user = process.env.USER
  if (!user) throw new Error('not supported on this desktop')
  await spawnDetached('loginctl', ['terminate-user', user])
}

async function toggleMute(): Promise<void> {
  if (binaryExists('wpctl')) {
    await spawnDetached('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'])
    return
  }
  if (binaryExists('pactl')) {
    await spawnDetached('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle'])
    return
  }
  throw new Error('not supported on this desktop')
}

async function volumeStep(up: boolean): Promise<void> {
  if (binaryExists('wpctl')) {
    await spawnDetached('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', up ? '5%+' : '5%-'])
    return
  }
  if (binaryExists('pactl')) {
    await spawnDetached('pactl', ['set-sink-volume', '@DEFAULT_SINK@', up ? '+5%' : '-5%'])
    return
  }
  throw new Error('not supported on this desktop')
}

async function volumeSet(percent: number): Promise<void> {
  if (binaryExists('wpctl')) {
    await spawnDetached('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', `${percent}%`])
    return
  }
  if (binaryExists('pactl')) {
    await spawnDetached('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${percent}%`])
    return
  }
  throw new Error('not supported on this desktop')
}

async function toggleAppearanceLinux(): Promise<void> {
  // GNOME only: reads the current `color-scheme` and flips it. Other
  // desktops have no equivalent freedesktop-standard toggle, and the
  // command is already hidden there via the `gsettings` PATH probe.
  const read = spawnSync('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme'])
  if (read.error || read.status !== 0) throw new Error('not supported on this desktop')
  const current = read.stdout.toString()
  const next = current.includes('dark') ? 'default' : 'prefer-dark'
  await spawnDetached('gsettings', ['set', 'org.gnome.desktop.interface', 'color-scheme', next])
}

async function osascript(script: string): Promise<void> {
  await spawnDetached('osascript', ['-e', script])
}

/** Runs `osascript` and returns its stdout, rather than fire-and-forget —
 *  needed for the volume/appearance toggles below, which have to read
 *  the current state before deciding what to flip it to. */
function osascriptSync(script: string): string {
  const result = spawnSync('osascript', ['-e', script])
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr?.toString().trim() || 'osascript failed')
  }
  return result.stdout.toString().trim()
}

/** `System Events`'s top-level `sleep`/`restart`/`shut down`/`log out`
 *  verbs run immediately, the same way `systemctl poweroff`/`reboot` do
 *  on Linux — no "are you sure?" dialog, unlike clicking the matching
 *  Apple-menu item. That's intentional here: this command already went
 *  through OpenRay's own confirm-before-running step (`CONFIRM_IDS`), a
 *  second native confirmation would be redundant. */
async function macosPowerVerb(verb: 'sleep' | 'restart' | 'shut down' | 'log out'): Promise<void> {
  await osascript(`tell application "System Events" to ${verb}`)
}

/** No Accessibility permission needed — same lock the login window's own
 *  Lock Screen menu item uses, invoked directly rather than through UI
 *  scripting. `CGSession` is a real, long-standing Apple binary (part of
 *  the login window's own "Menu Extras" bundle, not a private API this
 *  extension is reaching into) — this is the standard non-GUI way to
 *  trigger a lock from a script. */
async function macosLockScreen(): Promise<void> {
  await spawnDetached('/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend'])
}

async function macosToggleMute(): Promise<void> {
  const muted = osascriptSync('output muted of (get volume settings)')
  await osascript(`set volume output muted ${muted === 'true' ? 'false' : 'true'}`)
}

async function macosVolumeStep(up: boolean): Promise<void> {
  const current = Number(osascriptSync('output volume of (get volume settings)'))
  const next = Math.max(0, Math.min(100, current + (up ? 5 : -5)))
  await osascript(`set volume output volume ${next}`)
}

async function macosVolumeSet(percent: number): Promise<void> {
  await osascript(`set volume output volume ${percent}`)
}

/** Respects the user's own "Warn before emptying the Trash" Finder
 *  preference — if they've turned that on, Finder shows its own
 *  confirmation dialog here, same as using the Finder menu item
 *  directly. Not a bug: OpenRay's own `CONFIRM_IDS` step already ran
 *  before this action was reached, and silently bypassing a user's
 *  explicit Finder setting on top of that would be the wrong call. */
async function macosEmptyTrash(): Promise<void> {
  await osascript('tell application "Finder" to empty trash')
}

/** GNOME's toggle above has a real freedesktop setting to read back;
 *  macOS's AppleScript equivalent is a plain boolean already, so this is
 *  simpler — no read-then-decide needed, `not dark mode` is a single
 *  expression. */
async function macosToggleAppearance(): Promise<void> {
  await osascript('tell application "System Events" to tell appearance preferences to set dark mode to not dark mode')
}

/** No system-wide "whatever's currently playing" concept on macOS without
 *  a compiled helper against the private MediaRemote framework — this
 *  targets Spotify (if it's actually running; `tell application` would
 *  otherwise launch it just to receive a play/pause it wasn't part of)
 *  and falls back to Music.app otherwise, which ships on every Mac and
 *  is `tell`-able even while closed (AppleScript launches it). Mirrors
 *  `playerctl`'s own scope on Linux — it only reaches players speaking
 *  MPRIS, not literally anything producing sound either. */
function macosMediaTarget(): 'Spotify' | 'Music' {
  return spawnSync('pgrep', ['-x', 'Spotify']).status === 0 ? 'Spotify' : 'Music'
}

async function macosMediaCommand(verb: 'playpause' | 'next track' | 'previous track'): Promise<void> {
  await osascript(`tell application "${macosMediaTarget()}" to ${verb}`)
}

async function runActionLinux(id: string): Promise<void> {
  switch (id) {
    case 'lock-screen':
      return lockScreen()
    case 'sleep':
      return spawnDetached('systemctl', ['suspend'])
    case 'restart':
      return spawnDetached('systemctl', ['reboot'])
    case 'shut-down':
      return spawnDetached('systemctl', ['poweroff'])
    case 'log-out':
      return logOut()
    case 'sleep-displays':
      return spawnDetached('xset', ['dpms', 'force', 'off'])
    case 'screen-saver':
      return spawnDetached('xdg-screensaver', ['activate'])
    case 'play-pause':
      return spawnDetached('playerctl', ['play-pause'])
    case 'next-track':
      return spawnDetached('playerctl', ['next'])
    case 'previous-track':
      return spawnDetached('playerctl', ['previous'])
    case 'toggle-mute':
      return toggleMute()
    case 'volume-up':
      return volumeStep(true)
    case 'volume-down':
      return volumeStep(false)
    case 'volume-0':
      return volumeSet(0)
    case 'volume-25':
      return volumeSet(25)
    case 'volume-50':
      return volumeSet(50)
    case 'volume-75':
      return volumeSet(75)
    case 'volume-100':
      return volumeSet(100)
    case 'open-trash':
      return spawnDetached('gio', ['open', 'trash:///'])
    case 'empty-trash':
      return spawnDetached('gio', ['trash', '--empty'])
    case 'show-desktop':
      return spawnDetached('wmctrl', ['-k', 'on'])
    case 'toggle-bluetooth':
      return spawnDetached('rfkill', ['toggle', 'bluetooth'])
    case 'toggle-appearance':
      return toggleAppearanceLinux()
    default:
      throw new Error(`unknown system command '${id}'`)
  }
}

async function runActionMacos(id: string): Promise<void> {
  switch (id) {
    case 'lock-screen':
      return macosLockScreen()
    case 'sleep':
      return macosPowerVerb('sleep')
    case 'restart':
      return macosPowerVerb('restart')
    case 'shut-down':
      return macosPowerVerb('shut down')
    case 'log-out':
      return macosPowerVerb('log out')
    case 'sleep-displays':
      return spawnDetached('pmset', ['displaysleepnow'])
    case 'screen-saver':
      return spawnDetached('open', ['-a', 'ScreenSaverEngine'])
    case 'play-pause':
      return macosMediaCommand('playpause')
    case 'next-track':
      return macosMediaCommand('next track')
    case 'previous-track':
      return macosMediaCommand('previous track')
    case 'toggle-mute':
      return macosToggleMute()
    case 'volume-up':
      return macosVolumeStep(true)
    case 'volume-down':
      return macosVolumeStep(false)
    case 'volume-0':
      return macosVolumeSet(0)
    case 'volume-25':
      return macosVolumeSet(25)
    case 'volume-50':
      return macosVolumeSet(50)
    case 'volume-75':
      return macosVolumeSet(75)
    case 'volume-100':
      return macosVolumeSet(100)
    case 'open-trash':
      return spawnDetached('open', [join(homedir(), '.Trash')])
    case 'empty-trash':
      return macosEmptyTrash()
    case 'toggle-appearance':
      return macosToggleAppearance()
    default:
      throw new Error(`unknown system command '${id}'`)
  }
}

export async function runAction(id: string): Promise<void> {
  if (process.platform === 'darwin') return runActionMacos(id)
  return runActionLinux(id)
}
