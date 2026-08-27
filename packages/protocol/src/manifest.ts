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

export interface ExtensionManifest {
  name: string
  title: string
  description?: string
  icon?: string
  author?: string
  categories?: string[]
  commands: ExtensionCommandManifest[]
  preferences?: ExtensionPreference[]
}
