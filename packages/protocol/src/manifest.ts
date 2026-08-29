export type CommandMode = 'view' | 'no-view' | 'menu-bar'

export interface ExtensionCommandManifest {
  name: string
  title: string
  subtitle?: string
  description?: string
  mode: CommandMode
  icon?: string
  keywords?: string[]
  preferences?: ExtensionPreference[]
}

export type PreferenceType = 'textfield' | 'password' | 'checkbox' | 'dropdown' | 'appPicker' | 'file' | 'directory'

export interface PreferenceOption {
  title: string
  value: string
}

export interface ExtensionPreference {
  name: string
  type: PreferenceType
  title?: string
  label?: string
  description?: string
  required?: boolean
  default?: string | boolean
  placeholder?: string
  data?: PreferenceOption[]
}

/**
 * An extension's Import/Export declaration. `title`/`description` label its
 * row in the Settings pane; `entry` names the source module carrying the
 * `exportData`/`importData` hooks, defaulting to `"export"` (src/export.ts).
 */
export interface ExportDeclaration {
  title: string
  description?: string
  entry?: string
}

export interface ExtensionManifest {
  name: string
  title: string
  description?: string
  icon?: string
  author?: string
  categories?: string[]
  commands: ExtensionCommandManifest[]
  /**
   * Which operating systems the author says this extension supports
   * (`"macOS"` / `"Windows"`, and `"Linux"` for extensions written with us
   * in mind).
   *
   * Raycast treats an absent field as `["macOS"]`. We deliberately do not:
   * 72 of 180 sampled extensions simply predate the field, and only 3 of
   * those actually touch a macOS-only API — adopting Raycast's default
   * verbatim would exclude most of the catalogue for no safety gain. Absent
   * means *unknown* here.
   */
  platforms?: string[]
  preferences?: ExtensionPreference[]
  /** Opts this extension into Import/Export — see {@link ExportDeclaration}. */
  export?: ExportDeclaration
}
