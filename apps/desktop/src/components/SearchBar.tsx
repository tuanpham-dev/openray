import { useEffect, useRef, type ReactNode } from 'react'
import { useAutoWidth } from './useAutoWidth'
import { suppressHoverSelection } from './hoverSelection'
import { BackButton } from './BackButton'
import { subscribeEvent } from '../ipc/events'

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Renders a back button ahead of the search field. Sub-views pass this;
   *  the top-level palette has nothing to go back to. */
  onBack?: () => void
  /** Slot at the trailing edge, e.g. a type filter. */
  trailing?: ReactNode
  /** A selected command's argument fields, rendered inline after the query
   *  the way Raycast does — see `ArgumentFields`. */
  arguments?: ReactNode
  /** Shows a small spinner at the trailing edge (List/Grid `isLoading`). */
  loading?: boolean
}

export function SearchBar({ value, onChange, placeholder, onBack, trailing, loading, arguments: argumentFields }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  // With argument fields present the query shrinks to its own text so the
  // fields sit right beside it — Raycast puts them a single gap apart, not
  // at opposite ends of the bar.
  const [measureRef, queryWidth] = useAutoWidth<HTMLInputElement>(value, { min: 24, max: 420, placeholder: '' })
  // Latest props for listeners that subscribe once.
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }

  // The reopened palette keeps its previous query selected, so the first
  // keystroke replaces it (Raycast's reopen behaviour). The selection is
  // the real DOM one — safe now that Escape arrives via the backend's
  // global grab instead of WebKit's key path, which used to swallow it
  // while a selection was active. `pending` backs the selection up: right
  // after a show, WebKitGTK can drop the first keystroke before focus
  // settles, so this capture-phase listener applies the same
  // replace/clear semantics no matter where the key would have landed.
  const pendingRef = useRef(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pendingRef.current) return

      const input = inputRef.current
      if (input && document.activeElement !== input) input.focus()

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        event.stopPropagation()
        pendingRef.current = false
        latest.current.onChange('')
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        pendingRef.current = false
        latest.current.onChange(event.key)
      } else {
        // Escape, arrows, Enter, shortcuts: drop the pending state and let
        // the key do its normal job.
        pendingRef.current = false
      }
    }
    const onMouseDown = () => {
      pendingRef.current = false
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onMouseDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [])

  useEffect(() => {
    const focusInput = () => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.select()
    }

    const timers: ReturnType<typeof setTimeout>[] = []
    const unsubscribe = subscribeEvent('palette-shown', () => {
      // Focus settles asynchronously after show; assert it a few times.
      focusInput()
      requestAnimationFrame(focusInput)
      timers.push(setTimeout(focusInput, 80))
      if (latest.current.value !== '') pendingRef.current = true
      // A row can land right under a cursor the user never moved to get
      // there — see hoverSelection.ts's doc comment.
      suppressHoverSelection()
    })
    return () => {
      unsubscribe()
      timers.forEach(clearTimeout)
    }
  }, [])

  return (
    <div className="openray-search-bar">
      {onBack ? (
        // The back arrow stands in for the magnifier in sub-views — two
        // leading glyphs would just crowd the field.
        <BackButton onClick={onBack} />
      ) : (
        <svg className="openray-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 11L14.5 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      <input
        ref={(element) => {
          inputRef.current = element
          measureRef.current = element
        }}
        className="openray-search-input"
        type="text"
        value={value}
        onChange={(event) => {
          pendingRef.current = false
          // A new query re-renders the list under a cursor that never
          // moved to get there — see hoverSelection.ts's doc comment.
          suppressHoverSelection()
          onChange(event.target.value)
        }}
        placeholder={placeholder ?? 'Search for apps and commands…'}
        style={argumentFields ? { flex: '0 0 auto', width: queryWidth } : undefined}
        autoFocus
        spellCheck={false}
      />
      {argumentFields}
      {loading && <span className="openray-toast-spinner" aria-label="Loading" />}
      {trailing}
    </div>
  )
}
