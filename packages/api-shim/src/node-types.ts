/**
 * Host-intrinsic type strings used across the component library. These are
 * exactly the `type` field values that show up in `UiNode`s over the wire —
 * T22's renderer switches on them. Kept as constants so a typo doesn't
 * silently produce a node type nobody renders.
 */
export const NodeType = {
  List: 'List',
  ListItem: 'List.Item',
  ListSection: 'List.Section',
  ListEmptyView: 'List.EmptyView',
  ListDropdown: 'List.Dropdown',
  ListDropdownItem: 'List.Dropdown.Item',
  ListDropdownSection: 'List.Dropdown.Section',

  Grid: 'Grid',
  GridItem: 'Grid.Item',
  GridSection: 'Grid.Section',
  GridEmptyView: 'Grid.EmptyView',

  Detail: 'Detail',
  DetailMetadata: 'Detail.Metadata',
  DetailMetadataLabel: 'Detail.Metadata.Label',
  DetailMetadataLink: 'Detail.Metadata.Link',
  DetailMetadataTagList: 'Detail.Metadata.TagList',
  DetailMetadataTagListItem: 'Detail.Metadata.TagList.Item',
  DetailMetadataSeparator: 'Detail.Metadata.Separator',

  Form: 'Form',
  FormTextField: 'Form.TextField',
  FormPasswordField: 'Form.PasswordField',
  FormTextArea: 'Form.TextArea',
  FormCheckbox: 'Form.Checkbox',
  FormDropdown: 'Form.Dropdown',
  FormDropdownItem: 'Form.Dropdown.Item',
  FormDescription: 'Form.Description',
  FormFilePicker: 'Form.FilePicker',
  FormDatePicker: 'Form.DatePicker',
  FormTagPicker: 'Form.TagPicker',
  FormTagPickerItem: 'Form.TagPicker.Item',
  FormDropdownSection: 'Form.Dropdown.Section',
  /** A `Form.*` member this shim doesn't implement — rendered as an inert
   *  note in the form rather than crashing the command. See
   *  `namespace-fallback.ts`. */
  FormUnsupported: 'Form.Unsupported',
  FormSeparator: 'Form.Separator',

  /**
   * T25: OpenRay's own invention, not a real Raycast primitive — the host
   * renders a real, stateful TipTap instance for this node (see
   * `apps/desktop/src/components/markdown-editor/`), unlike every other
   * node type above which are stateless serialized-prop trees. Exported
   * from `@openray/extras` (`openray.cts`), never `@raycast/api`.
   */
  MarkdownEditor: 'MarkdownEditor',

  /** A `menu-bar` command's root, and its menu contents — rendered into
   *  the system tray by `application::menu_bar`, not into the palette. */
  MenuBarExtra: 'MenuBarExtra',
  MenuBarExtraItem: 'MenuBarExtra.Item',
  MenuBarExtraSection: 'MenuBarExtra.Section',
  MenuBarExtraSubmenu: 'MenuBarExtra.Submenu',

  ActionPanel: 'ActionPanel',
  ActionPanelSection: 'ActionPanel.Section',
  ActionPanelSubmenu: 'ActionPanel.Submenu',
  Action: 'Action',

  /**
   * Wraps a component's `actions` prop (itself an `<ActionPanel>` element)
   * as a real host child instead of a serialized prop — see reconciler.ts's
   * `serializeProps`, which deliberately skips `actions`/`children` as
   * props. T22 treats this node's single child as the row's context-menu
   * content, not inline visible content.
   */
  ActionsSlot: '__actions',
} as const

export type NodeTypeValue = (typeof NodeType)[keyof typeof NodeType]
