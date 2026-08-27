/**
 * The single seam where TipTap's document model meets markdown storage.
 *
 * Verified via a jsdom round-trip probe (see `plans/add-notes.md`'s
 * Decisions) that `tiptap-markdown` with `html: true` round-trips every
 * construct Raycast's format bar supports, including underline (which has
 * no markdown syntax and serializes as a literal `<u>` tag) — `html: true`
 * is required for that, not optional.
 *
 * TipTap v3's `StarterKit` already bundles `link` and `underline`
 * internally; adding `@tiptap/extension-link`/`-underline` separately
 * registers duplicate extension names, so only task lists are added on
 * top of it.
 */
import StarterKit from '@tiptap/starter-kit'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import type { AnyExtension, Editor } from '@tiptap/core'
import { createEmojiSuggestion } from './emojiSuggestion'

/** Every extension `MarkdownEditorCore` mounts with — the emoji-suggestion
 *  popup (`:`-triggered) is baked in unconditionally here rather than
 *  exposed as a caller-configurable option, matching T25's plan text
 *  ("emoji suggestion stays host-side in the editor component"): it's not
 *  extension-visible surface, just always-included plumbing identical for
 *  every `MarkdownEditor` instance regardless of which extension renders
 *  one. */
export function markdownEditorExtensions(placeholder: string): AnyExtension[] {
  return [
    StarterKit.configure({ link: { openOnClick: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder }),
    Markdown.configure({ html: true, transformPastedText: false }),
    createEmojiSuggestion(),
  ]
}

export function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown()
}
