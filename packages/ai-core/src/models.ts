/**
 * Model-id parsing/resolution — port of
 * `src-tauri/src/application/ai/providers/mod.rs`'s `split_model_id` and
 * `engine.rs`'s `resolve_base_url`. Model ids carry an explicit
 * `<provider>:<model>` prefix so the engine never has to guess which
 * adapter owns a given model string.
 */

/** `"anthropic:claude-sonnet-5"` → `["anthropic", "claude-sonnet-5"]`,
 *  `"cli:custom:my-agent"` → `["cli", "custom:my-agent"]`. */
export function splitModelId(model: string): [string, string] {
  const index = model.indexOf(':')
  if (index === -1) return [model, '']
  return [model.slice(0, index), model.slice(index + 1)]
}

/** `ollama`'s base URL always needs a default (there's no hosted endpoint
 *  to fall back to); every other provider's default lives in its own
 *  adapter module. */
export function resolveBaseUrl(provider: string, stored: string | undefined): string | undefined {
  if (provider === 'ollama') return stored ?? 'http://localhost:11434/v1'
  return stored
}

export const KNOWN_PROVIDERS = ['anthropic', 'openai', 'ollama', 'gemini', 'cli'] as const
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number]

export function isKnownProvider(provider: string): provider is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(provider)
}

export interface ModelInfo {
  id: string
  label: string
  provider: string
  supportsTools: boolean
}

/** A static catalog, matching `api::ai::ai_list_models` — good enough to
 *  populate a picker without a network round trip per provider. */
export const BUILTIN_MODELS: ModelInfo[] = [
  { id: 'anthropic:claude-fable-5', label: 'Claude Fable 5', provider: 'anthropic', supportsTools: true },
  { id: 'anthropic:claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', supportsTools: true },
  { id: 'anthropic:claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', supportsTools: true },
  { id: 'anthropic:claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', supportsTools: true },
  { id: 'openai:gpt-5.1', label: 'GPT-5.1', provider: 'openai', supportsTools: false },
  { id: 'openai:gpt-5.1-mini', label: 'GPT-5.1 Mini', provider: 'openai', supportsTools: false },
  { id: 'gemini:gemini-3-pro', label: 'Gemini 3 Pro', provider: 'gemini', supportsTools: false },
  { id: 'gemini:gemini-3-flash', label: 'Gemini 3 Flash', provider: 'gemini', supportsTools: false },
  { id: 'ollama:local', label: 'Ollama (local)', provider: 'ollama', supportsTools: false },
  { id: 'cli:claude-code', label: 'Claude Code (CLI)', provider: 'cli', supportsTools: false },
  { id: 'cli:codex', label: 'Codex (CLI)', provider: 'cli', supportsTools: false },
  { id: 'cli:antigravity', label: 'Antigravity (CLI)', provider: 'cli', supportsTools: false },
]
