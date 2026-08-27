import { describe, expect, it } from 'vitest'
import { sortChats, type ChatRecord } from '../src/chats'

function chat(overrides: Partial<ChatRecord>): ChatRecord {
  return {
    id: 'c1',
    title: 'Chat',
    pinned: false,
    archived: false,
    quick: false,
    agentId: null,
    model: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('sortChats', () => {
  it('excludes quick chats until promoted', () => {
    const chats = [chat({ id: 'q', quick: true })]
    expect(sortChats(chats)).toHaveLength(0)
  })

  it('sorts pinned chats before unpinned', () => {
    const chats = [chat({ id: 'a', updatedAt: 1000 }), chat({ id: 'b', updatedAt: 2000, pinned: true })]
    expect(sortChats(chats)[0]?.id).toBe('b')
  })

  it('sorts archived chats last', () => {
    const chats = [chat({ id: 'a', archived: true, updatedAt: 3000 }), chat({ id: 'b', updatedAt: 1000 })]
    expect(sortChats(chats).map((c) => c.id)).toEqual(['b', 'a'])
  })

  it('sorts newest-updated first within the same pinned/archived group', () => {
    const chats = [chat({ id: 'a', updatedAt: 1000 }), chat({ id: 'b', updatedAt: 2000 })]
    expect(sortChats(chats).map((c) => c.id)).toEqual(['b', 'a'])
  })
})
