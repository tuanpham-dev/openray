import { Action, ActionPanel, List, useNavigation } from '@raycast/api'
import { LANGUAGES } from '@openray/translate-core'

interface LanguagePickerProps {
  /** Only the source-language picker offers "Detect Language". */
  includeAuto?: boolean
  onSelect: (code: string) => void
}

/** A pushed list, not an overlay — this host renderer has no dedicated
 * overlay slot for extension views, and `List`'s own default title/
 * subtitle substring filtering (no `onSearchTextChange` wired here) is
 * a close enough match to native `LanguagePicker.tsx`'s own matching for
 * this generic a picker; the intent parser's stricter 4-tier match
 * (`@openray/translate-core`'s `matchLanguage`) is a separate concern for
 * root-search text, not this UI. */
export function LanguagePicker({ includeAuto, onSelect }: LanguagePickerProps) {
  const { pop } = useNavigation()
  const options = includeAuto ? [{ code: 'auto', name: 'Detect Language' }, ...LANGUAGES] : LANGUAGES

  return (
    <List searchBarPlaceholder="Search languages…" navigationTitle="Select Language">
      {options.map((lang) => (
        <List.Item
          key={lang.code}
          id={lang.code}
          title={lang.name}
          subtitle={lang.code === 'auto' ? undefined : lang.code}
          actions={
            <ActionPanel>
              <Action
                title="Select"
                onAction={() => {
                  onSelect(lang.code)
                  pop()
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
