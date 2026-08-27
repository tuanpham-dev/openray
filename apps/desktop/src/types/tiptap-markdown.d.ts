/** `tiptap-markdown` ships no type declarations of its own (dist/ has only
 *  .js + .js.map) — this covers the surface OpenRay actually uses. */
declare module 'tiptap-markdown' {
  import type { Extension } from '@tiptap/core'

  export interface MarkdownStorage {
    getMarkdown(): string
  }

  export interface MarkdownOptions {
    html?: boolean
    tightLists?: boolean
    tightListClass?: string
    bulletListMarker?: string
    linkify?: boolean
    breaks?: boolean
    transformPastedText?: boolean
    transformCopiedText?: boolean
  }

  export const Markdown: Extension<MarkdownOptions, MarkdownStorage>
}
