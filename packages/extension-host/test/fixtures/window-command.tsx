import { useEffect } from 'react'
import { openExtensionWindow } from '@openray/extras'

/** Mounted inside the extension window itself, not the command that opens
 *  it — proves the window's own tree is a real, independent second mount. */
function WindowContent(): null {
  return null
}

/** T24 fixture: opens an extension window on mount. Proves
 *  `openExtensionWindow` round-trips through `host.extensionWindow.open`,
 *  waits for `extension.windowReady`, and only then mounts + streams
 *  `ui.commit`s tagged with the window's own label. */
export default function WindowCommand(): null {
  useEffect(() => {
    void openExtensionWindow(<WindowContent />, { title: 'Fixture Window' })
  }, [])
  return null
}
