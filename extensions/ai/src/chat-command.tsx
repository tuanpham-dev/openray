import { useEffect } from 'react'
import { openOrFocusChatWindow } from './chat'

/** `no-view`: opens (or focuses) the persistent AI Chat window, showing
 *  its most recently active chat (or starting a fresh one). */
export default function ChatCommand() {
  useEffect(() => {
    void openOrFocusChatWindow(undefined, false)
  }, [])
  return null
}
