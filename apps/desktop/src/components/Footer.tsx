import { IconGlyph } from './IconGlyph'

interface FooterProps {
  primaryActionLabel?: string
  /** Name of the current sub-view, shown in place of the app name — the
   *  way Raycast labels the footer with the running command. */
  context?: string
  /** The running command's own icon (its manifest `icon`, already
   *  resolved server-side — see `ListItem.tsx`'s `ItemIcon` comment).
   *  Only meaningful alongside `context`; ignored otherwise. */
  contextIcon?: string | null
}

export function Footer({ primaryActionLabel = 'Open', context, contextIcon }: FooterProps) {
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
          {primaryActionLabel} <kbd>↵</kbd>
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
