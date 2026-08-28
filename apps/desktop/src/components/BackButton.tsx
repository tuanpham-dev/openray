/**
 * The leading back arrow of a sub-view's top bar — the `SearchBar`'s (where
 * it stands in for the magnifier) and a `Form`'s own header, which has no
 * search field but still needs the way out Raycast shows there.
 */
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="openray-search-back" aria-label="Go back" onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
