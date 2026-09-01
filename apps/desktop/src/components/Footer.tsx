import { IconGlyph } from './IconGlyph'

interface FooterProps {
  primaryActionLabel?: string
  /** True for a Form's submit action, the one case whose primary action
   *  actually fires on ⌘↵ rather than plain ↵ (see `ExtensionForm`'s
   *  key handler in `TreeRenderer.tsx` — plain Enter has to stay free for
   *  a text field's own editing, unlike a List/Grid row). Found live:
   *  the hint read "Create Quicklink ↵" and plain Enter silently did
   *  nothing, since it actually needed ⌘↵ — the hint just never said so. */
  primaryActionNeedsCmd?: boolean
  /** Name of the current sub-view, shown in place of the app name — the
   *  way Raycast labels the footer with the running command. */
  context?: string
  /** The running command's own icon (its manifest `icon`, already
   *  resolved server-side — see `ListItem.tsx`'s `ItemIcon` comment).
   *  Only meaningful alongside `context`; ignored otherwise. */
  contextIcon?: string | null
}

export function Footer({ primaryActionLabel = 'Open', primaryActionNeedsCmd = false, context, contextIcon }: FooterProps) {
  return (
    <div className="openray-footer">
      <span className="openray-footer-brand">
        <IconGlyph
          icon={context ? contextIcon : undefined}
          size={16}
          svgClassName="openray-footer-brand-icon-svg"
          imageClassName="openray-footer-brand-icon-image"
          textClassName="openray-footer-brand-icon-text"
          fallback={<img className="openray-footer-brand-mark" src="/favicon.svg" alt="" />}
        />
        {context ?? 'OpenRay'}
      </span>
      <div className="openray-footer-actions">
        <span className="openray-footer-hint">
          {primaryActionLabel} {primaryActionNeedsCmd && <kbd>⌘</kbd>}
          <kbd>↵</kbd>
        </span>
        <span className="openray-footer-divider" />
        <span className="openray-footer-hint">
          Actions <kbd>⌘</kbd>
          <kbd>K</kbd>
        </span>
      </div>
    </div>
  )
}
