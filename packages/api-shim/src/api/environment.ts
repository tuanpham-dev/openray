import { getCommandContext } from './command-context'

export enum LaunchType {
  UserInitiated = 'userInitiated',
  Background = 'background',
}

export interface Environment {
  readonly raycastVersion: string
  readonly extensionName: string
  readonly commandName: string
  readonly assetsPath: string
  readonly supportPath: string
  readonly isDevelopment: boolean
  readonly appearance: 'light' | 'dark'
  readonly launchType: 'userInitiated' | 'background'
  canAccess(api: unknown): boolean
}

// Getters, not a plain object captured at import time: command-context is
// set by the command driver (T22+) *after* this module is first imported
// (imports resolve before the driver knows which command is running), so a
// frozen snapshot here would always read the fallback values.
export const environment: Environment = {
  get raycastVersion() {
    return getCommandContext().raycastVersion
  },
  get extensionName() {
    return getCommandContext().extensionId
  },
  get commandName() {
    return getCommandContext().commandName
  },
  get assetsPath() {
    return getCommandContext().assetsPath
  },
  get supportPath() {
    return getCommandContext().supportPath
  },
  get isDevelopment() {
    return getCommandContext().isDevelopment
  },
  get appearance() {
    return getCommandContext().theme
  },
  get launchType(): 'userInitiated' | 'background' {
    return LaunchType.UserInitiated
  },
  canAccess() {
    // Nothing gated behind capability checks yet — every implemented API is
    // available, everything else throws UnsupportedError on use instead.
    return true
  },
}
