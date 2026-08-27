import { invoke } from '@tauri-apps/api/core'

/** OCR engine name active on this platform, or `null` if text search is
 *  unavailable — the Screenshots settings pane's status line (the pane
 *  itself stays native; the search/grid view moved to `extensions/screenshots`
 *  in T29). */
export function screenshotOcrStatus(): Promise<string | null> {
  return invoke('screenshot_ocr_status')
}
