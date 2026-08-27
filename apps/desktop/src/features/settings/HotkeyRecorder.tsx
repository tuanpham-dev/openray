import { useEffect, useRef, useState } from 'react'
import { CloseIcon } from '../../components/icons'

interface HotkeyRecorderProps {
  value: string | null
  placeholder?: string
  onRecord: (hotkey: string) => Promise<void>
  onClear?: () => Promise<void>
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
])

/** Modifiers currently held, in the order hotkey strings are built. */
function heldModifiers(event: KeyboardEvent): string[] {
  const held: string[] = []
  if (event.ctrlKey) held.push('Ctrl')
  if (event.altKey) held.push('Alt')
  if (event.shiftKey) held.push('Shift')
  if (event.metaKey) held.push('Super')
  return held
}

export function HotkeyRecorder({ value, placeholder, onRecord, onClear }: HotkeyRecorderProps) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [held, setHeld] = useState<string[]>([])
  // The popover is positioned with `fixed` off the button's measured rect
  // rather than absolutely inside the row: the table is a scroll container,
  // so an absolutely-positioned popover would be clipped at its edges.
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const stopRecording = () => {
    setRecording(false)
    setHeld([])
    setAnchor(null)
  }

  useEffect(() => {
    if (!recording) return

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.code === 'Escape') {
        stopRecording()
        return
      }

      setHeld(heldModifiers(event))
      if (MODIFIER_CODES.has(event.code)) return

      const parts = heldModifiers(event)
      if (parts.length === 0) {
        setError('Include at least one modifier key')
        return
      }

      parts.push(event.code)
      const hotkey = parts.join('+')
      stopRecording()
      setError(null)

      onRecord(hotkey).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
    }

    // Without a keyup listener the keycaps would latch on: releasing a
    // modifier produces no keydown, so the popover would keep showing it.
    const onKeyUp = (event: KeyboardEvent) => setHeld(heldModifiers(event))

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [recording, onRecord])

  const startRecording = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ left: rect.left + rect.width / 2, top: rect.top })
    setError(null)
    setHeld([])
    setRecording(true)
  }

  return (
    <div className="openray-hotkey-recorder">
      <div className="openray-hotkey-recorder-control">
        <button
          ref={buttonRef}
          type="button"
          className={`openray-hotkey-button${recording ? ' openray-hotkey-button--recording' : ''}${!value ? ' openray-hotkey-button--ghost' : ''}`}
          onClick={startRecording}
        >
          {recording ? 'Recording…' : (value ?? placeholder ?? 'Record Hotkey')}
        </button>
        {onClear && value && !recording && (
          <button
            type="button"
            className="openray-hotkey-clear"
            aria-label="Clear hotkey"
            onClick={() => {
              setError(null)
              void onClear()
            }}
          >
            <CloseIcon />
          </button>
        )}
      </div>

      {recording && anchor && (
        <div
          className="openray-hotkey-popover"
          role="status"
          style={{ left: anchor.left, top: anchor.top }}
        >
          <button
            type="button"
            className="openray-hotkey-popover-close"
            aria-label="Cancel recording"
            onClick={stopRecording}
          >
            <CloseIcon size={11} />
          </button>
          <div className="openray-hotkey-popover-keys">
            {held.length > 0 ? (
              held.map((modifier) => (
                <kbd key={modifier} className="openray-hotkey-cap">
                  {modifier}
                </kbd>
              ))
            ) : (
              <span className="openray-hotkey-popover-hint">e.g. Ctrl Alt K</span>
            )}
          </div>
          <span className="openray-hotkey-popover-label">Recording…</span>
        </div>
      )}

      {error && <span className="openray-hotkey-error">{error}</span>}
    </div>
  )
}
