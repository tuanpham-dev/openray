import { splitModelId } from '@openray/ai-core'
import { anthropicProvider } from './anthropic'
import { openAiCompatibleProvider } from './openai'
import { geminiProvider } from './gemini'
import { cliProvider } from './cli'
import type { ChatProvider } from './types'

export * from './types'

/** Resolves a model id to its provider — port of
 *  `providers::resolve`. */
export function resolveProvider(model: string): ChatProvider {
  const [provider] = splitModelId(model)
  switch (provider) {
    case 'anthropic':
      return anthropicProvider
    case 'openai':
    case 'ollama':
      return openAiCompatibleProvider
    case 'gemini':
      return geminiProvider
    case 'cli':
      return cliProvider
    default:
      throw new Error(`unknown_provider: '${provider}' (from model id '${model}')`)
  }
}
