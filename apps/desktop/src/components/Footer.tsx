interface FooterProps {
  primaryActionLabel?: string
  /** Name of the current sub-view, shown in place of the app name — the
   *  way Raycast labels the footer with the running command. */
  context?: string
}

export function Footer({ primaryActionLabel = 'Open', context }: FooterProps) {
  return (
    <div className="openray-footer">
      <span className="openray-footer-brand">
        <span className="openray-footer-brand-mark" />
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
