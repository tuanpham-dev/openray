import { getCommandContext } from './command-context'
import type { Capabilities, PlatformInfo } from './command-context'

export type { Capabilities, PlatformInfo }

// Getters, not a plain object captured at import time — same reasoning as
// `environment.ts`: command-context is set by the command driver after
// this module is first imported, so a frozen snapshot here would always
// read the fallback values.
export const platform: PlatformInfo = {
  get os() {
    return getCommandContext().platform.os
  },
  get displayServer() {
    return getCommandContext().platform.displayServer
  },
}

export const capabilities: Capabilities = {
  get selectionRead() {
    return getCommandContext().capabilities.selectionRead
  },
  get dropAtCursor() {
    return getCommandContext().capabilities.dropAtCursor
  },
  get multiFormatClipboard() {
    return getCommandContext().capabilities.multiFormatClipboard
  },
  get menuBarIntrospection() {
    return getCommandContext().capabilities.menuBarIntrospection
  },
  get windowControl() {
    return getCommandContext().capabilities.windowControl
  },
}
