import { showToast, Toast } from '@raycast/api'
import { getFocusedFrame, getWorkArea, listDisplays, setFrame, setFullscreen, getWindowSettings, type WindowFrame, type Rect as HostRect } from '@openray/extras'
import { customFrame, remapToDisplay, rectContainsPoint, targetFrame, type Half, type Rect, type WindowAction } from '@openray/window-layout'
import { getWindowCommand, type WindowCommand } from './storage'
import { TABLE } from './table'

// Session-lifetime state, mirroring native `WindowManagementProvider`'s
// process-lifetime `restore`/`cycle`/`fullscreened` fields — but backed
// by a `globalThis` slot, NOT plain module-level bindings. Discovered
// live (a Restore right after a preset silently no-opped, "No previous
// position to restore"): `packages/extension-host/src/runner.ts`'s
// `requireFreshCommandModule` deletes this file's `require.cache` entry
// and re-requires it on *every* `execute()` call — a deliberate
// hot-reload/clean-state mechanism for root-provider row activation —
// which means a plain `const restoreMap = new Map()` here is a *fresh,
// empty* Map on every single invocation, never surviving from one preset
// to the next. `globalThis` has no such per-require identity: it's the
// same Node process/V8 isolate across every fresh `require()`, so a slot
// there really does persist for the sidecar's lifetime — matching what
// this module's own stale doc comment (and `@openray/api-shim`'s own
// `global-slot.ts`, which solves an adjacent problem the same way)
// already assumed was true of plain module state. Still resets on a
// sidecar crash-and-respawn (rare, error-recovery only), where the
// native process itself never crashes independently of the whole app —
// same "process-lifetime, not persisted" tradeoff as before, just now
// actually process-lifetime instead of per-call.
interface SessionState {
  restoreMap: Map<string, Rect>
  cycleState: { windowId: string; half: Half; step: number } | null
  fullscreenedSet: Set<string>
}

const SESSION_STATE_KEY = '__openrayWindowManagementSessionState__'

function session(): SessionState {
  const g = globalThis as unknown as Record<string, SessionState | undefined>
  if (!g[SESSION_STATE_KEY]) {
    g[SESSION_STATE_KEY] = { restoreMap: new Map(), cycleState: null, fullscreenedSet: new Set() }
  }
  return g[SESSION_STATE_KEY] as SessionState
}

function toLayoutRect(r: { x: number; y: number; width: number; height: number }): Rect {
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}

function toHostRect(r: Rect): HostRect {
  return { x: r.x, y: r.y, width: r.w, height: r.h }
}

async function toast(title: string, message: string): Promise<void> {
  await showToast({ style: Toast.Style.Failure, title, message })
}

/** Advances the halves cycle when `action` repeats the same half on the
 * same window as last time and cycling is enabled; resets (and returns
 * step 0) for any other action, window, or when cycling is off. */
async function cycleStepFor(windowId: string, action: WindowAction): Promise<number> {
  const s = session()
  if (action.kind !== 'half') {
    s.cycleState = null
    return 0
  }
  const settings = await getWindowSettings()
  if (!settings.halfCycling) {
    s.cycleState = null
    return 0
  }
  const step = s.cycleState && s.cycleState.windowId === windowId && s.cycleState.half === action.half ? (s.cycleState.step + 1) % 3 : 0
  s.cycleState = { windowId, half: action.half, step }
  return step
}

async function applyFrame(windowId: string, current: Rect, action: WindowAction): Promise<void> {
  const workAreaHost = await getWorkArea(windowId)
  if (!workAreaHost) {
    await toast('Window Management', "Couldn't determine the screen area")
    return
  }
  const settings = await getWindowSettings()
  const cycleStep = await cycleStepFor(windowId, action)
  const target = targetFrame(action, current, toLayoutRect(workAreaHost), settings.windowGap, cycleStep)
  session().restoreMap.set(windowId, current)
  if (!(await setFrame(windowId, toHostRect(target)))) {
    await toast('Window Management', "Couldn't move that window")
  }
}

async function applyCustom(windowId: string, current: Rect, custom: WindowCommand): Promise<void> {
  const workAreaHost = await getWorkArea(windowId)
  if (!workAreaHost) {
    await toast(custom.title, "Couldn't determine the screen area")
    return
  }
  const target = customFrame(custom.unit, custom.x, custom.y, custom.width, custom.height, toLayoutRect(workAreaHost))
  const s = session()
  s.restoreMap.set(windowId, current)
  s.cycleState = null
  if (!(await setFrame(windowId, toHostRect(target)))) {
    await toast(custom.title, "Couldn't move that window")
  }
}

async function restoreFrame(windowId: string): Promise<void> {
  const s = session()
  s.cycleState = null
  const saved = s.restoreMap.get(windowId)
  if (!saved) {
    await toast('Restore', 'No previous position to restore')
    return
  }
  s.restoreMap.delete(windowId)
  if (!(await setFrame(windowId, toHostRect(saved)))) {
    await toast('Restore', "Couldn't restore that window")
  }
}

async function toggleFullscreen(windowId: string): Promise<void> {
  const s = session()
  s.cycleState = null
  const entering = !s.fullscreenedSet.has(windowId)
  if (await setFullscreen(windowId, entering)) {
    if (entering) s.fullscreenedSet.add(windowId)
    else s.fullscreenedSet.delete(windowId)
  } else {
    await toast('Toggle Fullscreen', "Couldn't toggle fullscreen for that window")
  }
}

async function hopDisplay(windowId: string, current: Rect, forward: boolean): Promise<void> {
  session().cycleState = null
  const displaysHost = await listDisplays()
  if (displaysHost.length < 2) return
  const displays = displaysHost.map(toLayoutRect)
  const cx = current.x + current.w / 2
  const cy = current.y + current.h / 2
  const foundIndex = displays.findIndex((d) => rectContainsPoint(d, cx, cy))
  const currentIndex = foundIndex === -1 ? 0 : foundIndex
  const delta = forward ? 1 : -1
  const nextIndex = ((currentIndex + delta) % displays.length + displays.length) % displays.length
  const remapped = remapToDisplay(current, displays[currentIndex], displays[nextIndex])
  if (!(await setFrame(windowId, toHostRect(remapped)))) {
    await toast('Window Management', "Couldn't move that window to the other display")
  }
}

/** Both open a view; the frontend takes over from there — mirrors native
 * `execute()`'s early return for `SEARCH_WINDOW_COMMANDS_ID`/
 * `CREATE_WINDOW_COMMAND_ID`, except those two are now ordinary `view`
 * manifest commands the host dispatches directly, so this module never
 * even sees their ids. */
export async function runPreset(id: string, focused: WindowFrame): Promise<void> {
  const entry = TABLE.find((e) => e.id === id)
  if (!entry) return
  const { windowId } = focused
  const current = toLayoutRect(focused)
  switch (entry.kind.type) {
    case 'frame':
      await applyFrame(windowId, current, entry.kind.action)
      return
    case 'restore':
      await restoreFrame(windowId)
      return
    case 'toggle-fullscreen':
      await toggleFullscreen(windowId)
      return
    case 'next-display':
      await hopDisplay(windowId, current, true)
      return
    case 'previous-display':
      await hopDisplay(windowId, current, false)
      return
  }
}

export async function runCustom(custom: WindowCommand, focused: WindowFrame): Promise<void> {
  await applyCustom(focused.windowId, toLayoutRect(focused), custom)
}

export async function execute(id: string): Promise<void> {
  const entry = TABLE.find((e) => e.id === id)
  const custom = entry ? undefined : await getWindowCommand(id)
  if (!entry && !custom) return

  const focused = await getFocusedFrame()
  if (!focused) {
    await toast(entry?.title ?? custom!.title, 'No focused window to manage')
    return
  }

  if (entry) {
    await runPreset(id, focused)
  } else {
    await runCustom(custom!, focused)
  }
}
