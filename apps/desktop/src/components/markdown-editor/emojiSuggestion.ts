/**
 * The `:` inline emoji picker inside `MarkdownEditorCore` (Raycast: "type
 * `:` for inline picker"). Reuses the existing emoji dataset from the
 * palette's own Emoji & Symbols command (`features/emoji/emojiData.ts`)
 * rather than adding a second emoji source or a TipTap Pro extension.
 */
import { Extension } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { EMOJI_SECTIONS, type EmojiEntry } from '../../features/emoji/emojiData'

const ALL_EMOJI: EmojiEntry[] = EMOJI_SECTIONS.flatMap((section) => section.items)
const MAX_RESULTS = 8

function matchEmoji(query: string): EmojiEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return ALL_EMOJI.slice(0, MAX_RESULTS)
  return ALL_EMOJI.filter((entry) => entry.n.toLowerCase().includes(needle)).slice(0, MAX_RESULTS)
}

class EmojiPopup {
  readonly element: HTMLDivElement
  private items: EmojiEntry[] = []
  private selected = 0
  private readonly onPick: (entry: EmojiEntry) => void

  constructor(onPick: (entry: EmojiEntry) => void) {
    this.onPick = onPick
    this.element = document.createElement('div')
    this.element.className = 'openray-notes-emoji-suggest'
  }

  setItems(items: EmojiEntry[]): void {
    this.items = items
    this.selected = Math.min(this.selected, Math.max(items.length - 1, 0))
    this.render()
  }

  moveSelection(direction: 1 | -1): void {
    if (this.items.length === 0) return
    this.selected = (this.selected + direction + this.items.length) % this.items.length
    this.render()
  }

  pickSelected(): boolean {
    const item = this.items[this.selected]
    if (!item) return false
    this.onPick(item)
    return true
  }

  private render(): void {
    this.element.innerHTML = ''
    this.element.style.display = this.items.length === 0 ? 'none' : 'flex'
    this.items.forEach((item, index) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `openray-notes-emoji-suggest-item${index === this.selected ? ' openray-notes-emoji-suggest-item--selected' : ''}`
      row.textContent = `${item.e}  ${item.n}`
      row.onmousedown = (event) => {
        event.preventDefault()
        this.onPick(item)
      }
      this.element.appendChild(row)
    })
  }
}

export function createEmojiSuggestion(): Extension {
  return Extension.create({
    name: 'emojiSuggestion',
    addProseMirrorPlugins() {
      return [
        Suggestion<EmojiEntry, EmojiEntry>({
          editor: this.editor,
          char: ':',
          allowSpaces: false,
          items: ({ query }) => matchEmoji(query),
          command: ({ editor, range, props }) => {
            editor.chain().focus().insertContentAt(range, props.e).run()
          },
          render: () => {
            let popup: EmojiPopup | null = null
            let unmount: (() => void) | null = null

            return {
              onStart: (props) => {
                popup = new EmojiPopup((item) => props.command(item))
                popup.setItems(props.items)
                unmount = props.mount(popup.element)
              },
              onUpdate: (props) => {
                popup?.setItems(props.items)
              },
              onKeyDown: (props) => {
                if (!popup) return false
                if (props.event.key === 'ArrowDown') {
                  popup.moveSelection(1)
                  return true
                }
                if (props.event.key === 'ArrowUp') {
                  popup.moveSelection(-1)
                  return true
                }
                if (props.event.key === 'Enter' || props.event.key === 'Tab') {
                  return popup.pickSelected()
                }
                return false
              },
              onExit: () => {
                unmount?.()
                popup = null
                unmount = null
              },
            }
          },
        }),
      ]
    },
  })
}
