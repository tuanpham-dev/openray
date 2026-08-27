import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import { markdownEditorExtensions, getMarkdown } from './markdown'

/** T25: debounced settle time for `onChange` — reused verbatim from the
 *  native notes window's own autosave timing (which solved the identical
 *  "don't pay `getMarkdown()`'s full-document-walk cost on every
 *  keystroke" problem for "save to DB"; here it's "notify the extension"
 *  instead, but the cost and the fix are the same). */
const CHANGE_DEBOUNCE_MS = 500

export interface MarkdownEditorHandle {
  /** Flushes a pending debounced `onChange` immediately, bypassing the
   *  timer — call before switching documents or hiding the host window so
   *  nothing typed is lost to an in-flight timer. */
  flush: () => void
}

export interface MarkdownEditorCoreProps {
  /** Identifies which document `value` belongs to. The editor only ever
   *  re-seeds its content when this changes (it's `useEditor`'s own deps
   *  key, below) — a same-document re-render must never clobber
   *  in-progress typing with a stale `value`, the exact bug T25's port of
   *  the native notes editor's own `noteId`-gated effect avoids. */
  documentId: string | number
  value: string
  onChange: (markdown: string) => void
  placeholder?: string
  onEditorReady?: (editor: Editor | null) => void
}

export const MarkdownEditorCore = forwardRef<MarkdownEditorHandle, MarkdownEditorCoreProps>(function MarkdownEditorCore(
  { documentId, value, onChange, placeholder = 'Start typing…', onEditorReady },
  ref,
) {
  const changeTimer = useRef<number | null>(null)
  const lastEmitted = useRef(value)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const flush = (editor: Editor) => {
    if (changeTimer.current !== null) {
      window.clearTimeout(changeTimer.current)
      changeTimer.current = null
    }
    const markdown = getMarkdown(editor)
    if (markdown === lastEmitted.current) return
    lastEmitted.current = markdown
    onChangeRef.current(markdown)
  }

  // `documentId` in the deps array (not `[]`): switching documents gets a
  // fresh editor instance, `content`/`extensions` (and so the placeholder
  // text baked into them) freshly re-evaluated from this render's props.
  // T26 found the alternative — keeping one editor alive and trying to
  // change its placeholder text later via `Editor.setOptions` or a forced
  // transaction — doesn't work: `setOptions` never rebuilds the extension
  // manager, and even directly mutating the live Placeholder extension's
  // options and dispatching a transaction left the decoration showing the
  // stale text (its DOM widget is a `Decoration.node()` object that
  // ProseMirror's own decoration diffing didn't judge as invalidated).
  // Recreating on document switch is also the semantically correct
  // behavior anyway — cursor position/undo history from a different note
  // (or the transient "loading…" stand-in before a note's real content
  // arrives) shouldn't carry over.
  const editor = useEditor(
    {
      extensions: markdownEditorExtensions(placeholder),
      content: value,
      autofocus: 'end',
      onCreate: () => {
        lastEmitted.current = value
      },
      onUpdate: ({ editor }) => {
        if (changeTimer.current !== null) window.clearTimeout(changeTimer.current)
        changeTimer.current = window.setTimeout(() => flush(editor), CHANGE_DEBOUNCE_MS)
      },
      onBlur: ({ editor }) => flush(editor),
    },
    [documentId],
  )

  useImperativeHandle(ref, () => ({ flush: () => flush(editor) }), [editor])

  useEffect(() => {
    onEditorReady?.(editor)
    return () => onEditorReady?.(null)
  }, [editor, onEditorReady])

  return <EditorContent editor={editor} className="openray-notes-editor" />
})
