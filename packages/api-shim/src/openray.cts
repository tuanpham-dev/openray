// `@openray/extras` — OpenRay's own extras, kept entirely separate from
// `index.cts`'s `@raycast/api` compat surface (never mutates a
// Raycast-named export; see the refactor plan's cross-platform-contract
// constraint). `.cts`, not `.ts`, for the same esbuild CJS interop reason
// as index.cts/utils.cts.
//
// Unlike index.cts/utils.cts, this has no stub-Proxy fallback: there's no
// real external package to shim compatibility with, so an import of
// something this module doesn't (yet) export should just be `undefined`,
// same as importing an unknown name from any other real module.

import { platform, capabilities } from './api/platform'
import { refreshRootCommands } from './api/root-commands'
import {
  isAvailable,
  getFocusedFrame,
  setFrame,
  getWorkArea,
  listDisplays,
  setFullscreen,
  getWindowSettings,
  canListWindows,
  listWindows,
  focusWindow,
  closeWindow,
} from './api/window'
import { getScriptDirectories, allowAssetDirectory } from './api/scripts'
import { getTranslateSettings, setTranslateTargetLanguage } from './api/translate'
import { getNotesSettings } from './api/notes'
import { getAiSettings } from './api/ai'
import {
  listClipboardHistory,
  getClipboardHistoryEntry,
  deleteClipboardHistoryEntry,
  clearClipboardHistory,
  pasteClipboardHistoryEntry,
  pasteImageClipboardHistoryEntry,
} from './api/clipboardHistory'
import {
  getScreenshotsSettings,
  queryScreenshots,
  pasteScreenshotWithFormat,
  copyScreenshotWithFormat,
  dropScreenshot,
  screenshotDropSupported,
  openScreenshot,
  pasteLatestScreenshot,
  dropLatestScreenshot,
  setScreenshotPinned,
} from './api/screenshots'
import { getFileSearchSettings, queryFileSearch } from './api/file-search'
import { developExtension } from './api/dev'
import {
  listRegistrySources,
  fetchCatalog,
  listInstalledExtensions,
  classifyInstall,
  installFromRegistry,
  uninstallExtension,
} from './api/registry'
import { listMenuBarItems, activateMenuBarItem } from './api/menuBar'
import { openExtensionWindow } from './window-mounter'
import { MarkdownEditor } from './components/MarkdownEditor'

module.exports = {
  __esModule: false,
  platform,
  capabilities,
  refreshRootCommands,
  openExtensionWindow,
  MarkdownEditor,
  getNotesSettings,
  getAiSettings,
  isAvailable,
  getFocusedFrame,
  setFrame,
  getWorkArea,
  listDisplays,
  setFullscreen,
  getWindowSettings,
  canListWindows,
  listWindows,
  focusWindow,
  closeWindow,
  getScriptDirectories,
  allowAssetDirectory,
  getTranslateSettings,
  setTranslateTargetLanguage,
  listClipboardHistory,
  getClipboardHistoryEntry,
  deleteClipboardHistoryEntry,
  clearClipboardHistory,
  pasteClipboardHistoryEntry,
  pasteImageClipboardHistoryEntry,
  getScreenshotsSettings,
  queryScreenshots,
  pasteScreenshotWithFormat,
  copyScreenshotWithFormat,
  dropScreenshot,
  screenshotDropSupported,
  openScreenshot,
  pasteLatestScreenshot,
  dropLatestScreenshot,
  setScreenshotPinned,
  getFileSearchSettings,
  queryFileSearch,
  developExtension,
  listRegistrySources,
  fetchCatalog,
  listInstalledExtensions,
  classifyInstall,
  installFromRegistry,
  uninstallExtension,
  listMenuBarItems,
  activateMenuBarItem,
}
