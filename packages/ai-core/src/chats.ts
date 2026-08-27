/**
 * Chat sorting/filtering — port of
 * `src-tauri/src/application/ai/storage.rs`'s `select_chats` ORDER BY
 * clause. Storage itself (LocalStorage-backed CRUD) lives in
 * `extensions/ai/src/storage.ts`; this module is the pure ordering logic.
 */

export interface ChatRecord {
  id: string
  title: string
  pinned: boolean
  archived: boolean
  quick: boolean
  agentId: string | null
  model: string | null
  createdAt: number
  updatedAt: number
}

/** Non-quick, non-archived chats first (pinned first within that), newest
 *  first — quick-AI ephemeral threads stay out of the sidebar until
 *  promoted. Matches `ORDER BY archived ASC, pinned DESC, updated_at DESC`
 *  applied after `WHERE quick = 0`. */
export function sortChats(chats: ChatRecord[]): ChatRecord[] {
  return chats
    .filter((c) => !c.quick)
    .slice()
    .sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
}
