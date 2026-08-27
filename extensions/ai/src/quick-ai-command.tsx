import { useEffect } from 'react'
import { openOrFocusChatWindow, setPendingQuery } from './chat'

interface QuickAiCommandProps {
  arguments: { query?: string }
}

/** `no-view`: opens (or focuses) a dedicated ephemeral "quick" chat
 *  window and — when launched with an initial query (Tab-from-root; see
 *  `apps/desktop/src/App.tsx`'s Tab handler) — sends it immediately.
 *  Matches native `QuickAiView`'s own role: a fast, single-purpose ask
 *  that can later be "Continue in Chat"-promoted (see `chat.tsx`'s
 *  `promoteQuickChat` action). */
export default function QuickAiCommand({ arguments: { query } }: QuickAiCommandProps) {
  useEffect(() => {
    if (query?.trim()) setPendingQuery(query.trim())
    void openOrFocusChatWindow(undefined, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
