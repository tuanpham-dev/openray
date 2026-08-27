import { List } from '@openray/api'
import { useCachedState } from '@openray/utils'

/** Imports the compat surface under OpenRay's own package names rather than
 * `@raycast/*` — proves both spellings resolve to the same modules. */
export default function OpenRayImportCommand() {
  const [title] = useCachedState('openray-import-title', 'Imported via @openray/api')

  return (
    <List>
      <List.Item id="row" title={title} />
    </List>
  )
}
