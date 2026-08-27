import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { useNavigation } from '../hooks'
import { Clipboard } from '../api/clipboard'
import { open as openTarget, showHUD } from '../api/system'

export interface ActionProps {
  title: string
  icon?: string
  shortcut?: { modifiers: string[]; key: string }
  onAction?: () => void
  style?: 'regular' | 'destructive'
}

export function Action(props: ActionProps): ReactElement {
  return createElement(NodeType.Action, props)
}

export interface ActionOpenInBrowserProps {
  url: string
  title?: string
  shortcut?: { modifiers: string[]; key: string }
}
function ActionOpenInBrowser(props: ActionOpenInBrowserProps): ReactElement {
  return createElement(NodeType.Action, {
    ...props,
    title: props.title ?? 'Open in Browser',
    __variant: 'open-in-browser',
    onAction: () => {
      void openTarget(props.url)
    },
  })
}

export interface ActionCopyToClipboardProps {
  content: string
  title?: string
  shortcut?: { modifiers: string[]; key: string }
  onCopy?: (content: string) => void
}
function ActionCopyToClipboard(props: ActionCopyToClipboardProps): ReactElement {
  const { onCopy, ...rest } = props
  return createElement(NodeType.Action, {
    ...rest,
    title: props.title ?? 'Copy to Clipboard',
    __variant: 'copy-to-clipboard',
    onAction: () => {
      void Clipboard.copy(props.content).then(() => {
        showHUD('Copied to Clipboard')
        onCopy?.(props.content)
      })
    },
  })
}

export interface ActionPasteProps {
  content: string
  title?: string
  shortcut?: { modifiers: string[]; key: string }
  onPaste?: (content: string) => void
}
function ActionPaste(props: ActionPasteProps): ReactElement {
  const { onPaste, ...rest } = props
  return createElement(NodeType.Action, {
    ...rest,
    title: props.title ?? 'Paste',
    __variant: 'paste',
    onAction: () => {
      void Clipboard.paste(props.content).then(() => onPaste?.(props.content))
    },
  })
}

export interface ActionPushProps {
  title: string
  icon?: string
  target: ReactElement
  shortcut?: { modifiers: string[]; key: string }
}
function ActionPush(props: ActionPushProps): ReactElement {
  const { push } = useNavigation()
  const { target, ...rest } = props
  return createElement(NodeType.Action, { ...rest, __variant: 'push', onAction: () => push(target) })
}

export interface ActionSubmitFormProps {
  title?: string
  icon?: string
  onSubmit?: (values: Record<string, unknown>) => void | boolean | Promise<void | boolean>
  shortcut?: { modifiers: string[]; key: string }
}
function ActionSubmitForm(props: ActionSubmitFormProps): ReactElement {
  return createElement(NodeType.Action, { ...props, title: props.title ?? 'Submit Form', __variant: 'submit-form' })
}

Action.OpenInBrowser = ActionOpenInBrowser
Action.CopyToClipboard = ActionCopyToClipboard
Action.Paste = ActionPaste
Action.Push = ActionPush
Action.SubmitForm = ActionSubmitForm

export interface ActionPanelSectionProps {
  title?: string
  children?: ReactNode
}
function ActionPanelSection(props: ActionPanelSectionProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.ActionPanelSection, rest, children)
}

export interface ActionPanelSubmenuProps {
  title: string
  icon?: string
  children?: ReactNode
}
function ActionPanelSubmenu(props: ActionPanelSubmenuProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.ActionPanelSubmenu, rest, children)
}

export interface ActionPanelProps {
  title?: string
  children?: ReactNode
}

export function ActionPanel(props: ActionPanelProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.ActionPanel, rest, children)
}
ActionPanel.Section = ActionPanelSection
ActionPanel.Submenu = ActionPanelSubmenu
