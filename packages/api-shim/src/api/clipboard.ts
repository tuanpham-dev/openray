import { getHostBridge } from '../bridge'

export interface ClipboardContent {
  text?: string
  file?: string
  html?: string
}

export interface ClipboardCopyOptions {
  concealed?: boolean
}

export interface ClipboardReadOptions {
  offset?: number
}

async function copy(content: string | ClipboardContent, options?: ClipboardCopyOptions): Promise<void> {
  await getHostBridge().call('host.clipboard.copy', { content, options })
}

async function paste(content: string | ClipboardContent): Promise<void> {
  await getHostBridge().call('host.clipboard.paste', { content })
}

async function read(options?: ClipboardReadOptions): Promise<ClipboardContent> {
  const result = await getHostBridge().call('host.clipboard.read', options)
  return (result ?? {}) as ClipboardContent
}

async function readText(options?: ClipboardReadOptions): Promise<string | undefined> {
  return (await read(options)).text
}

async function clear(options?: ClipboardReadOptions): Promise<void> {
  await getHostBridge().call('host.clipboard.clear', options)
}

export const Clipboard = { copy, paste, read, readText, clear }
