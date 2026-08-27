import { ActionPanel, Action, List } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'

export default function ContextCallbackCommand() {
  return (
    <List>
      <List.Item
        id="row"
        title="Row"
        actions={
          <ActionPanel>
            <Action
              title="Go"
              onAction={() => {
                void refreshRootCommands()
              }}
            />
          </ActionPanel>
        }
      />
    </List>
  )
}
