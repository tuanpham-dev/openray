/**
 * Inline SVG icons.
 *
 * These replace Unicode symbol characters (⚙, ▦, ✕). Those render from
 * whichever fallback font supplies the glyph, usually at a smaller optical
 * size than the surrounding text and with no way to correct it reliably —
 * bumping font-size just moves the text box, not the glyph's proportions.
 * An SVG scales exactly to the size it's given.
 *
 * Paths follow Feather's geometry (24x24 viewBox, 1.5 stroke, no fill), so
 * they share a consistent weight.
 */

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 20, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function GearIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  )
}

/* Import / Export: an arrow leaving and an arrow arriving. */
export function TransferIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v12" />
      <path d="M4 7l4-4 4 4" />
      <path d="M16 21V9" />
      <path d="M20 17l-4 4-4-4" />
    </Svg>
  )
}

export function DownloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Svg>
  )
}

export function AdvancedIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </Svg>
  )
}

export function CloseIcon({ size = 12, ...props }: IconProps) {
  return (
    <Svg size={size} {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  )
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4.5" />
      <line x1="12" y1="1.5" x2="12" y2="3.5" />
      <line x1="12" y1="20.5" x2="12" y2="22.5" />
      <line x1="4.2" y1="4.2" x2="5.6" y2="5.6" />
      <line x1="18.4" y1="18.4" x2="19.8" y2="19.8" />
      <line x1="1.5" y1="12" x2="3.5" y2="12" />
      <line x1="20.5" y1="12" x2="22.5" y2="12" />
      <line x1="4.2" y1="19.8" x2="5.6" y2="18.4" />
      <line x1="18.4" y1="5.6" x2="19.8" y2="4.2" />
    </Svg>
  )
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Svg>
  )
}

/** Half-filled circle — the conventional "match the system" mark. */
export function SystemThemeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/**
 * A window outline with the palette drawn inside it at the relative size
 * the setting produces, so the options read as a comparison rather than
 * three identical glyphs.
 */
export function WindowSizeIcon({ scale, ...props }: IconProps & { scale: 'small' | 'medium' | 'large' }) {
  const inner = {
    small: { x: 8, y: 9.5, width: 8, height: 5 },
    medium: { x: 6, y: 8.5, width: 12, height: 7 },
    large: { x: 4, y: 7, width: 16, height: 10 },
  }[scale]

  return (
    <Svg {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <rect {...inner} rx="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </Svg>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  )
}

export function ClipboardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </Svg>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </Svg>
  )
}

export function CrosshairIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <line x1="22" y1="12" x2="18" y2="12" />
      <line x1="6" y1="12" x2="2" y2="12" />
      <line x1="12" y1="6" x2="12" y2="2" />
      <line x1="12" y1="22" x2="12" y2="18" />
    </Svg>
  )
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </Svg>
  )
}

export function MailIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="2.5 6.5 12 13 21.5 6.5" />
    </Svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="16.2" y1="16.2" x2="21" y2="21" />
    </Svg>
  )
}

export function SendIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </Svg>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  )
}

export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17.9 17.9A10.4 10.4 0 0 1 12 20c-7 0-11-8-11-8a19.6 19.6 0 0 1 5.1-6" />
      <path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a19.6 19.6 0 0 1-2.2 3.3" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </Svg>
  )
}

export function CalculatorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <line x1="8" y1="6" x2="16" y2="6" />
      <line x1="8" y1="11" x2="8" y2="11" />
      <line x1="12" y1="11" x2="12" y2="11" />
      <line x1="16" y1="11" x2="16" y2="11" />
      <line x1="8" y1="15" x2="8" y2="15" />
      <line x1="12" y1="15" x2="12" y2="15" />
      <line x1="16" y1="15" x2="16" y2="18" />
      <line x1="8" y1="18" x2="12" y2="18" />
    </Svg>
  )
}

export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </Svg>
  )
}

export function ScissorsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.1" y2="15.9" />
      <line x1="14.5" y1="14.5" x2="20" y2="20" />
      <line x1="8.1" y1="8.1" x2="12" y2="12" />
    </Svg>
  )
}

export function SmileyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      {/* Zero-length strokes: `stroke-linecap: round` on the shared <Svg>
          renders each as a dot, which stays round at every size where a
          tiny <circle> would go lumpy. */}
      <line x1="9.3" y1="9.8" x2="9.31" y2="9.8" />
      <line x1="14.7" y1="9.8" x2="14.71" y2="9.8" />
    </Svg>
  )
}

export function ChevronDownIcon({ size = 12, ...props }: IconProps) {
  return (
    <Svg size={size} {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  )
}

export function ArrowRightIcon({ size = 18, ...props }: IconProps) {
  return (
    <Svg size={size} {...props}>
      <line x1="4" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </Svg>
  )
}

export function AppWindowIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <line x1="2" y1="9" x2="22" y2="9" />
      <line x1="5.5" y1="6.5" x2="5.5" y2="6.5" />
      <line x1="8.5" y1="6.5" x2="8.5" y2="6.5" />
    </Svg>
  )
}

export function PuzzleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.5a2 2 0 1 1 4 0V5h3a1 1 0 0 1 1 1v3h1.5a2 2 0 1 1 0 4H18v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 1 0-4 0V18H5a1 1 0 0 1-1-1v-4h1.5a2 2 0 1 0 0-4H4V6a1 1 0 0 1 1-1h5z" />
    </Svg>
  )
}

export function HashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </Svg>
  )
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="8.5 12.5 11 15 15.5 9.5" />
    </Svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="11" width="15" height="10" rx="2" />
      <path d="M7.5 11V7a4.5 4.5 0 0 1 9 0v4" />
    </Svg>
  )
}

export function PowerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="12" y1="3" x2="12" y2="12" />
      <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
    </Svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" />
      <polyline points="4 3.5 4 8.5 9 8.5" />
      <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5" />
      <polyline points="20 20.5 20 15.5 15 15.5" />
    </Svg>
  )
}

export function LogOutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <line x1="3" y1="12" x2="14.5" y2="12" />
      <polyline points="10.5 8 14.5 12 10.5 16" />
    </Svg>
  )
}

export function MonitorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </Svg>
  )
}

export function MonitorOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4h16.7a2 2 0 0 1 2 2v9.3" />
      <path d="M21.5 17H8" />
      <path d="M4.5 17a2 2 0 0 1-2-2V6c0-.4.1-.8.3-1.1" />
      <line x1="8" y1="21" x2="14.5" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </Svg>
  )
}

export function SparklesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 4l1.3 3.7L16 9l-3.7 1.3L11 14l-1.3-3.7L6 9l3.7-1.3L11 4z" />
      <path d="M18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
    </Svg>
  )
}

export function PlayPauseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 5.5v13l8-6.5-8-6.5z" fill="currentColor" stroke="none" />
      <line x1="16.5" y1="5.5" x2="16.5" y2="18.5" />
      <line x1="20.5" y1="5.5" x2="20.5" y2="18.5" />
    </Svg>
  )
}

export function SkipForwardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 5.5v13l10-6.5-10-6.5z" fill="currentColor" stroke="none" />
      <line x1="19" y1="5.5" x2="19" y2="18.5" />
    </Svg>
  )
}

export function SkipBackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19.5 5.5v13l-10-6.5 10-6.5z" fill="currentColor" stroke="none" />
      <line x1="5" y1="5.5" x2="5" y2="18.5" />
    </Svg>
  )
}

/** Bare speaker — the base of the volume family, used for the quietest
 *  non-muted preset. */
export function VolumeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="4 9.5 8.5 9.5 13 5.5 13 18.5 8.5 14.5 4 14.5 4 9.5" />
    </Svg>
  )
}

export function Volume1Icon(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="3 9.5 7.5 9.5 12 5.5 12 18.5 7.5 14.5 3 14.5 3 9.5" />
      <path d="M15.5 9.5a4 4 0 0 1 0 5" />
    </Svg>
  )
}

export function Volume2Icon(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="3 9.5 7.5 9.5 12 5.5 12 18.5 7.5 14.5 3 14.5 3 9.5" />
      <path d="M15.5 9.5a4 4 0 0 1 0 5" />
      <path d="M18.5 6.5a8 8 0 0 1 0 11" />
    </Svg>
  )
}

export function VolumeXIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="3 9.5 7.5 9.5 12 5.5 12 18.5 7.5 14.5 3 14.5 3 9.5" />
      <line x1="16" y1="9.5" x2="21" y2="14.5" />
      <line x1="21" y1="9.5" x2="16" y2="14.5" />
    </Svg>
  )
}

export function BluetoothIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5" />
    </Svg>
  )
}

/**
 * Window Management icons: a 24x24 window frame (matching `WindowSizeIcon`'s
 * outer rect) with the occupied region drawn as a filled inner rect — the
 * same "show the option, don't just label it" language `WindowSizeIcon`
 * already established for Small/Medium/Large.
 */
const WINDOW_FRAME = { x: 2, y: 4, width: 20, height: 16, rx: 2 }

function WindowFrameIcon({ inner, ...props }: IconProps & { inner: { x: number; y: number; width: number; height: number } }) {
  return (
    <Svg {...props}>
      <rect {...WINDOW_FRAME} />
      <rect {...inner} rx="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function WindowLeftHalfIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 2, y: 4, width: 10, height: 16 }} />
}

export function WindowRightHalfIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 12, y: 4, width: 10, height: 16 }} />
}

export function WindowTopHalfIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 2, y: 4, width: 20, height: 8 }} />
}

export function WindowBottomHalfIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 2, y: 12, width: 20, height: 8 }} />
}

/** Shared across all four corners — the row title names the specific one. */
export function WindowQuarterIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 2, y: 4, width: 10, height: 8 }} />
}

/** Shared across all six cells. */
export function WindowSixthIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 2, y: 4, width: 6.7, height: 8 }} />
}

/** Shared across First/Center/Last. */
export function WindowThirdIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 2, y: 4, width: 6.7, height: 16 }} />
}

/** Shared across First/Last two-thirds. */
export function WindowTwoThirdsIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 2, y: 4, width: 13.3, height: 16 }} />
}

export function WindowMaximizeIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 3, y: 5, width: 18, height: 14 }} />
}

export function WindowAlmostMaximizeIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 4, y: 6, width: 16, height: 12 }} />
}

export function WindowMaximizeHeightIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 8, y: 4, width: 8, height: 16 }} />
}

export function WindowMaximizeWidthIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 2, y: 8, width: 20, height: 8 }} />
}

export function WindowReasonableSizeIcon(props: IconProps) {
  return <WindowFrameIcon {...props} inner={{ x: 7, y: 8, width: 10, height: 8 }} />
}

/** A center point, not a filled region — Center keeps size and just moves,
 *  so a target-style dot reads more accurately than another size swatch. */
export function WindowCenterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect {...WINDOW_FRAME} />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** A counter-clockwise arc — "go back to where it was". */
export function WindowRestoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12a8 8 0 1 0 8-8" />
      <polyline points="4 6 4 12 10 12" />
    </Svg>
  )
}

export function WindowLargerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </Svg>
  )
}

export function WindowSmallerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="4 9 4 4 9 4" />
      <polyline points="20 15 20 20 15 20" />
      <line x1="4" y1="4" x2="10" y2="10" />
      <line x1="20" y1="20" x2="14" y2="14" />
    </Svg>
  )
}

/** Shared across Move Left/Right/Up/Down. */
export function WindowMoveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="5 9 2 12 5 15" />
      <polyline points="9 5 12 2 15 5" />
      <polyline points="15 19 12 22 9 19" />
      <polyline points="19 9 22 12 19 15" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </Svg>
  )
}

export function DisplayNextIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1" y="6" width="9" height="7" rx="1" />
      <rect x="14" y="6" width="9" height="7" rx="1" />
      <line x1="10.5" y1="9.5" x2="13.5" y2="9.5" />
      <polyline points="12 7.5 14 9.5 12 11.5" />
    </Svg>
  )
}

export function DisplayPreviousIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1" y="6" width="9" height="7" rx="1" />
      <rect x="14" y="6" width="9" height="7" rx="1" />
      <line x1="10.5" y1="9.5" x2="13.5" y2="9.5" />
      <polyline points="12 7.5 10 9.5 12 11.5" />
    </Svg>
  )
}

/** The classic four-corner-bracket "enter fullscreen" glyph — deliberately
 *  frame-less so it reads distinctly from the window-frame icons above. */
export function WindowFullscreenIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="8 3 3 3 3 8" />
      <polyline points="16 3 21 3 21 8" />
      <polyline points="21 16 21 21 16 21" />
      <polyline points="3 16 3 21 8 21" />
    </Svg>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </Svg>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Svg>
  )
}

export function TextIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </Svg>
  )
}

export function DragIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="5 9 2 12 5 15" />
      <polyline points="9 5 12 2 15 5" />
      <polyline points="15 19 12 22 9 19" />
      <polyline points="19 9 22 12 19 15" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </Svg>
  )
}

export function CameraIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </Svg>
  )
}

export function AutoPasteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2 14.5 9.5 22 12 14.5 14.5 12 22 9.5 14.5 2 12 9.5 9.5 Z" />
      <path d="M19 4v3M17.5 5.5h3" />
    </Svg>
  )
}

export function FilmIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2" width="20" height="20" rx="2" />
      <line x1="7" y1="2" x2="7" y2="22" />
      <line x1="17" y1="2" x2="17" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="2" y1="7" x2="7" y2="7" />
      <line x1="2" y1="17" x2="7" y2="17" />
      <line x1="17" y1="17" x2="22" y2="17" />
      <line x1="17" y1="7" x2="22" y2="7" />
    </Svg>
  )
}

export function TranslateIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 8h9M9 4v2m0 0c0 4-2 8-6 10m4-4c1.5 1.5 3.5 2.5 5 3" />
      <path d="m14 21 4-9 4 9M15.5 18h5" />
    </Svg>
  )
}

export function SwapIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4v14M3 14l4 4 4-4" />
      <path d="M17 20V6m4 4-4-4-4 4" />
    </Svg>
  )
}

/** A frame with `count` filled vertical strips — the same
 *  frame-plus-filled-inner-shape language as `WindowSizeIcon`, used to
 *  represent the grid's column-count choices (3–6). */
export function GridColumnsIcon({ count, ...props }: IconProps & { count: number }) {
  const innerX = 4
  const innerY = 6
  const innerWidth = 16
  const innerHeight = 12
  const gap = 1.5
  const barWidth = (innerWidth - gap * (count - 1)) / count

  return (
    <Svg {...props}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      {Array.from({ length: count }, (_, i) => (
        <rect
          key={i}
          x={innerX + i * (barWidth + gap)}
          y={innerY}
          width={barWidth}
          height={innerHeight}
          rx="0.5"
          fill="currentColor"
          stroke="none"
        />
      ))}
    </Svg>
  )
}

export function NoteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </Svg>
  )
}

export function PinIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3z" />
    </Svg>
  )
}

export function CodeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9 18-6-6 6-6M15 6l6 6-6 6" />
    </Svg>
  )
}

export function QuoteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 8a3 3 0 0 0-3 3v2a2 2 0 0 0 2 2h2v-6a2 2 0 0 0-1-2z" />
      <path d="M17 8a3 3 0 0 0-3 3v2a2 2 0 0 0 2 2h2v-6a2 2 0 0 0-1-2z" />
    </Svg>
  )
}

export function StrikethroughIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14M8 6.5c0-1.5 1.8-2.5 4-2.5s4 1 4 2.5M8 17.5c0 1.5 1.8 2.5 4 2.5s4.5-1 4.5-2.7c0-1.2-.7-2-2-2.5" />
    </Svg>
  )
}
