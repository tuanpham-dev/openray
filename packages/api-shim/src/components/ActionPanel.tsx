import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { useNavigation } from '../hooks'
import { Clipboard } from '../api/clipboard'
import { open as openTarget, showHUD, showInFinder } from '../api/system'
import { Icon } from '../api/icon'
import { withFallbacks } from './namespace-fallback'

export interface ActionProps {
  title: string
  icon?: string
  shortcut?: { modifiers: string[]; key: string }
  onAction?: () => void
  style?: 'regular' | 'destructive'
}

function ActionBase(props: ActionProps): ReactElement {
  return createElement(NodeType.Action, props)
}

export interface ActionOpenInBrowserProps {
  url: string
  title?: string
  icon?: string
  shortcut?: { modifiers: string[]; key: string }
}
function ActionOpenInBrowser(props: ActionOpenInBrowserProps): ReactElement {
  return createElement(NodeType.Action, {
    ...props,
    title: props.title ?? 'Open in Browser',
    // Raycast's built-in actions come with their own icon; without a
    // default these rows sat blank next to ones that named an icon.
    icon: props.icon ?? Icon.Globe,
    __variant: 'open-in-browser',
    onAction: () => {
      void openTarget(props.url)
    },
  })
}

export interface ActionCopyToClipboardProps {
  content: string
  title?: string
  icon?: string
  shortcut?: { modifiers: string[]; key: string }
  onCopy?: (content: string) => void
}
function ActionCopyToClipboard(props: ActionCopyToClipboardProps): ReactElement {
  const { onCopy, ...rest } = props
  return createElement(NodeType.Action, {
    ...rest,
    title: props.title ?? 'Copy to Clipboard',
    icon: props.icon ?? Icon.Clipboard,
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
  icon?: string
  shortcut?: { modifiers: string[]; key: string }
  onPaste?: (content: string) => void
}
function ActionPaste(props: ActionPasteProps): ReactElement {
  const { onPaste, ...rest } = props
  return createElement(NodeType.Action, {
    ...rest,
    title: props.title ?? 'Paste',
    icon: props.icon ?? Icon.Clipboard,
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
/**
 * Turns the renderer's tagged date values back into `Date` objects.
 *
 * `Form.DatePicker`'s value is a `Date` on the extension's side, but every
 * prop crosses to the renderer as JSON. The renderer sends `{__date: iso}`
 * so the type is recoverable here — a bare string would reach the
 * extension as a string and break `values.when.getTime()`, which is
 * exactly how an extension uses it.
 */
function reviveValues(values: unknown): unknown {
  if (!values || typeof values !== 'object') return values
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (value && typeof value === 'object' && '__date' in (value as object)) {
      const iso = (value as { __date: string | null }).__date
      out[key] = iso ? new Date(iso) : null
    } else {
      out[key] = value
    }
  }
  return out
}

function ActionSubmitForm(props: ActionSubmitFormProps): ReactElement {
  const { onSubmit, ...rest } = props
  return createElement(NodeType.Action, {
    ...rest,
    title: props.title ?? 'Submit Form',
    icon: props.icon ?? Icon.ArrowRight,
    __variant: 'submit-form',
    ...(onSubmit
      ? { onSubmit: (values: Record<string, unknown>) => onSubmit(reviveValues(values) as Record<string, unknown>) }
      : {}),
  })
}

/**
 * Raycast's action styling enum, referenced *while rendering*
 * (`style={Action.Style.Destructive}`). A missing nested enum is not a
 * cosmetic gap: the property access throws mid-render and takes the whole
 * command down. Same class of failure as `Grid.Fit`, found the same way —
 * by running a real extension (`wikipedia`) rather than reading the API
 * surface.
 *
 * The renderer does not style destructive actions differently yet; carrying
 * the values keeps such extensions running until it does.
 */
ActionBase.Style = { Regular: 'regular', Destructive: 'destructive' } as const

export interface ActionCreateSnippetProps {
  snippet: { text: string; name?: string; keyword?: string }
  title?: string
  icon?: string
  shortcut?: { modifiers: string[]; key: string }
}
/**
 * Renders, but reports that snippets are not a thing here.
 *
 * OpenRay has no snippet store to write to. Leaving the component out
 * entirely was not the cheaper option: `Action.CreateSnippet` then
 * evaluates to `undefined`, React throws "Element type is invalid" during
 * render, and the *whole command* fails to mount —
 * `unicode-symbols` showed nothing at all because of this one action.
 */
function ActionCreateSnippet(props: ActionCreateSnippetProps): ReactElement {
  const { snippet, ...rest } = props
  return createElement(NodeType.Action, {
    ...rest,
    title: props.title ?? 'Create Snippet',
    icon: props.icon ?? Icon.SaveDocument,
    __variant: 'create-snippet',
    onAction: () => {
      void showHUD(`Snippets aren't supported yet — copied "${snippet.name ?? snippet.text}" instead`)
      void Clipboard.copy(snippet.text)
    },
  })
}

ActionBase.OpenInBrowser = ActionOpenInBrowser
ActionBase.CopyToClipboard = ActionCopyToClipboard
ActionBase.Paste = ActionPaste
ActionBase.Push = ActionPush
ActionBase.SubmitForm = ActionSubmitForm
export interface ActionOpenProps {
  target: string
  /** An app to open with — `open()` already takes one. */
  application?: string
  title?: string
  icon?: string
  shortcut?: { modifiers: string[]; key: string }
  onOpen?: (target: string) => void
}
/** Raycast's generic "open this thing", used by 11 of 180 sampled
 *  extensions — a file, folder or URL, optionally in a named app. */
function ActionOpen(props: ActionOpenProps): ReactElement {
  const { target, application, onOpen, ...rest } = props
  return createElement(NodeType.Action, {
    ...rest,
    title: props.title ?? 'Open',
    icon: props.icon ?? Icon.Link,
    __variant: 'open',
    onAction: () => {
      void openTarget(target, application).then(() => onOpen?.(target))
    },
  })
}

export interface ActionShowInFinderProps {
  path: string
  title?: string
  icon?: string
  shortcut?: { modifiers: string[]; key: string }
  onShow?: (path: string) => void
}
/** Reveals a path in the system file manager. Named for Finder because
 *  Raycast is, but `showInFinder` already resolves to whatever this
 *  platform actually uses. */
function ActionShowInFinder(props: ActionShowInFinderProps): ReactElement {
  const { path, onShow, ...rest } = props
  return createElement(NodeType.Action, {
    ...rest,
    title: props.title ?? 'Show in Finder',
    icon: props.icon ?? Icon.Folder,
    __variant: 'show-in-finder',
    onAction: () => {
      void showInFinder(path).then(() => onShow?.(path))
    },
  })
}

ActionBase.Open = ActionOpen
ActionBase.ShowInFinder = ActionShowInFinder
ActionBase.CreateSnippet = ActionCreateSnippet

/**
 * Any `Action.*` variant this shim doesn't implement, rendered as an
 * ordinary row that says so when run.
 *
 * Raycast ships dozens of these (`Open`, `OpenWith`, `ShowInFinder`,
 * `Trash`, `ToggleQuickLook`, `PickDate`, `CreateQuicklink`, …) and an
 * unimplemented one is not an inert gap: `Action.Trash` is `undefined`,
 * React throws "Element type is invalid" during render, and the entire
 * command fails to mount over a single action in a menu the user may
 * never open. Degrading to a visible, honest row keeps the rest of the
 * extension working — which is the same trade the module-level stub proxy
 * already makes for non-component APIs.
 *
 * Deliberately narrow: only capitalized string properties that aren't
 * already defined, so `Style`, `prototype`, `$$typeof` and symbol lookups
 * behave exactly as before.
 */
const actionWithFallbacks = withFallbacks(ActionBase, (name) => {
  return (props: { title?: string; icon?: string; shortcut?: unknown }): ReactElement =>
    createElement(NodeType.Action, {
      ...props,
      title: props.title ?? name,
      __variant: 'unsupported',
      onAction: () => {
        void showHUD(`"Action.${name}" isn't supported yet`)
      },
    })
})

/** The `Action` extensions actually see. */
export const Action = actionWithFallbacks

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
