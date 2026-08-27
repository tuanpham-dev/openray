import { spawn, spawnSync } from 'node:child_process'
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

async function toggleAppearance(): Promise<void> {
  // GNOME only: reads the current `color-scheme` and flips it. Other
  // desktops have no equivalent freedesktop-standard toggle, and the
  // command is already hidden there via the `gsettings` PATH probe.
  const read = spawnSync('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme'])
  if (read.error || read.status !== 0) throw new Error('not supported on this desktop')
  const current = read.stdout.toString()
  const next = current.includes('dark') ? 'default' : 'prefer-dark'
  await spawnDetached('gsettings', ['set', 'org.gnome.desktop.interface', 'color-scheme', next])
}

export async function runAction(id: string): Promise<void> {
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
      return toggleAppearance()
    default:
      throw new Error(`unknown system command '${id}'`)
  }
}
