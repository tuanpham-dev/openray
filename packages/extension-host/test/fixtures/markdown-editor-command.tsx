import { MarkdownEditor } from '@openray/extras'

/** T25 fixture: proves `MarkdownEditor`'s `value`/`onChange` props round
 *  trip through the reconciler like any other node — no host-side TipTap
 *  instance runs in this test (that only exists in the browser frontend),
 *  just the prop-serialization/callback-wiring the extension side sees. */
export default function MarkdownEditorCommand() {
  return (
    <MarkdownEditor
      id="doc-1"
      value="# Hello"
      onChange={(markdown) => {
        const events = ((globalThis as Record<string, unknown>).__fixtureEvents ??= []) as string[]
        events.push(`markdown-editor:onChange:${markdown}`)
      }}
    />
  )
}
