import { describe, expect, it } from 'vitest'
import { sortNotes, searchNotes, toNote, type NoteRecord } from '../src/sort'

function record(id: string, content: string, overrides: Partial<NoteRecord> = {}): NoteRecord {
  return { id, content, pinnedAt: null, createdAt: 1000, updatedAt: 1000, lastOpenedAt: 1000, ...overrides }
}

describe('sortNotes', () => {
  it('sorts pinned notes before unpinned ones', () => {
    const unpinned = toNote(record('a', 'unpinned', { lastOpenedAt: 1000 }))
    const pinned = toNote(record('b', 'pinned', { pinnedAt: 5000 }))

    expect(sortNotes([unpinned, pinned]).map((n) => n.id)).toEqual(['b', 'a'])
  })

  it('orders pinned notes oldest-pinned-first', () => {
    const a = toNote(record('a', 'a', { pinnedAt: 2000 }))
    const b = toNote(record('b', 'b', { pinnedAt: 1000 }))

    expect(sortNotes([a, b]).map((n) => n.id)).toEqual(['b', 'a'])
  })

  it('orders unpinned notes by most-recently-opened first', () => {
    const older = toNote(record('older', 'older', { lastOpenedAt: 1000 }))
    const newer = toNote(record('newer', 'newer', { lastOpenedAt: 2000 }))

    expect(sortNotes([older, newer]).map((n) => n.id)).toEqual(['newer', 'older'])
  })
})

describe('searchNotes', () => {
  it('matches the title case-insensitively including non-ASCII', () => {
    const notes = [toNote(record('a', 'Übung macht den Meister')), toNote(record('b', 'unrelated'))]

    const results = searchNotes(notes, 'übung')
    expect(results.map((n) => n.id)).toEqual(['a'])
  })

  it('matches body content, not just the title', () => {
    const notes = [toNote(record('a', 'Groceries\nbuy milk and eggs'))]

    expect(searchNotes(notes, 'milk')).toHaveLength(1)
  })

  it('returns every note in sorted order for an empty query', () => {
    const notes = [toNote(record('a', 'a', { lastOpenedAt: 1000 })), toNote(record('b', 'b', { lastOpenedAt: 2000 }))]

    expect(searchNotes(notes, '  ').map((n) => n.id)).toEqual(['b', 'a'])
  })
})
