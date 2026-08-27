import { useState } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { CodeIcon, LinkIcon, QuoteIcon, StrikethroughIcon } from '../icons'

interface FormatBarProps {
  editor: Editor
}

function headingValue(editor: Editor): string {
  for (const level of [1, 2, 3] as const) {
    if (editor.isActive('heading', { level })) return String(level)
  }
  return 'paragraph'
}

export function FormatBar({ editor }: FormatBarProps) {
  const [linkInputOpen, setLinkInputOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      link: editor.isActive('link'),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      taskList: editor.isActive('taskList'),
      blockquote: editor.isActive('blockquote'),
      heading: headingValue(editor),
    }),
  })

  const applyLink = () => {
    const url = linkUrl.trim()
    if (url) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    } else {
      editor.chain().focus().unsetLink().run()
    }
    setLinkInputOpen(false)
    setLinkUrl('')
  }

  const openLinkInput = () => {
    if (state.link) {
      editor.chain().focus().unsetLink().run()
      return
    }
    setLinkUrl('')
    setLinkInputOpen(true)
  }

  if (linkInputOpen) {
    return (
      <div className="openray-notes-formatbar">
        <input
          autoFocus
          className="openray-notes-formatbar-link-input"
          value={linkUrl}
          placeholder="https://…"
          onChange={(event) => setLinkUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              applyLink()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setLinkInputOpen(false)
              setLinkUrl('')
            }
          }}
        />
        <button type="button" className="openray-notes-formatbar-button" onMouseDown={(e) => e.preventDefault()} onClick={applyLink}>
          Add Link
        </button>
      </div>
    )
  }

  return (
    <div className="openray-notes-formatbar">
      <select
        className="openray-notes-formatbar-select"
        value={state.heading}
        onChange={(event) => {
          const value = event.target.value
          if (value === 'paragraph') {
            editor.chain().focus().setParagraph().run()
          } else {
            editor.chain().focus().toggleHeading({ level: Number(value) as 1 | 2 | 3 }).run()
          }
        }}
      >
        <option value="paragraph">Text</option>
        <option value="1">Heading 1</option>
        <option value="2">Heading 2</option>
        <option value="3">Heading 3</option>
      </select>

      <div className="openray-notes-formatbar-divider" />

      <FormatButton active={state.bold} label="Bold" onClick={() => editor.chain().focus().toggleBold().run()}>
        B
      </FormatButton>
      <FormatButton active={state.italic} label="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}>
        <em>I</em>
      </FormatButton>
      <FormatButton active={state.underline} label="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <u>U</u>
      </FormatButton>
      <FormatButton active={state.strike} label="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}>
        <StrikethroughIcon size={14} />
      </FormatButton>
      <FormatButton active={state.code} label="Code" onClick={() => editor.chain().focus().toggleCode().run()}>
        <CodeIcon size={14} />
      </FormatButton>
      <FormatButton active={state.link} label="Link" onClick={openLinkInput}>
        <LinkIcon size={14} />
      </FormatButton>

      <div className="openray-notes-formatbar-divider" />

      <FormatButton active={state.bulletList} label="Bullet List" onClick={() => editor.chain().focus().toggleBulletList().run()}>
        •
      </FormatButton>
      <FormatButton active={state.orderedList} label="Ordered List" onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1.
      </FormatButton>
      <FormatButton active={state.taskList} label="Task List" onClick={() => editor.chain().focus().toggleTaskList().run()}>
        ☑
      </FormatButton>
      <FormatButton active={state.blockquote} label="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <QuoteIcon size={14} />
      </FormatButton>
    </div>
  )
}

interface FormatButtonProps {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}

function FormatButton({ active, label, onClick, children }: FormatButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={`openray-notes-formatbar-button${active ? ' openray-notes-formatbar-button--active' : ''}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
