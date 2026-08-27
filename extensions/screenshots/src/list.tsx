import { showToast, Toast } from '@raycast/api'
import { dropLatestScreenshot, getScreenshotsSettings, pasteLatestScreenshot, screenshotDropSupported } from '@openray/extras'
import { ScreenshotsGrid } from './ScreenshotsGrid'

/** T29: "no scopes → no rows" — matches native `build_commands`'s own
 *  `scopes.is_empty()` early return exactly, just moved here since a
 *  static manifest command can't be conditional the way a root-provider's
 *  dynamic rows can. "Drop Latest Screenshot" is further gated on XDND
 *  support, same as native's `drop_supported` parameter. */
export default async function listRootCommands() {
  const settings = await getScreenshotsSettings()
  if (settings.searchScopes.length === 0) return []

  const rows = [
    { id: 'search', title: 'Search Screenshots', subtitle: 'Built-in Command', opensView: true, icon: 'camera' },
    { id: 'paste-latest', title: 'Paste Latest Screenshot', subtitle: 'Built-in Command', icon: 'clipboard' },
  ]
  if (await screenshotDropSupported()) {
    rows.push({ id: 'drop-latest', title: 'Drop Latest Screenshot', subtitle: 'Built-in Command', icon: 'drag' })
  }
  return rows
}

export async function execute(id: string): Promise<void> {
  if (id === 'paste-latest') {
    const { found } = await pasteLatestScreenshot()
    if (!found) await showToast({ style: Toast.Style.Failure, title: 'Paste Latest Screenshot', message: 'No screenshots found' })
    return
  }
  if (id === 'drop-latest') {
    const { found } = await dropLatestScreenshot()
    if (!found) await showToast({ style: Toast.Style.Failure, title: 'Drop Latest Screenshot', message: 'No screenshots found' })
  }
  // 'search' always has `opensView: true` above — never reached for it.
}

interface ViewProps {
  id: string
}

/** Mounted for the 'search' row (`opensView: true` above). */
export function view(_props: ViewProps) {
  return <ScreenshotsGrid />
}
