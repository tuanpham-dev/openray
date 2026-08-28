import { ChevronDownIcon } from '../../components/icons'
import { StringListField } from './StringListField'
import { updateSettings, type Settings } from '../../ipc/settings'
// `./models` subpath (not the package's own `.` barrel) — the barrel also
// re-exports `oauth.ts`, which needs Node's `crypto`/`Buffer` types this
// browser-context frontend project doesn't have; `models.ts` alone has
// zero Node dependencies.
import { BUILTIN_MODELS } from '@openray/ai-core/models'

interface AiPrefsProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

/** T27: provider keys, AI Commands, Agents, Skills discovery, and MCP
 *  servers all moved to the `ai` extension's own storage/commands ("AI
 *  Providers", "Search AI Commands", "Create Agent", "Manage MCP
 *  Servers" — all reachable from root search) — this section keeps only
 *  the fields that genuinely stayed native `AppState.settings` (read live
 *  by the extension via `host.ai.getSettings`, same reasoning as
 *  `NotesPrefs`'s `notesAlwaysOnTop`). */
export function AiPrefs({ settings, onChange }: AiPrefsProps) {
  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  return (
    <div className="openray-settings-form">
      <label className="openray-settings-form-label" htmlFor="ai-default-model">
        Default Model
      </label>
      <div className="openray-form-field">
        <select id="ai-default-model" value={settings.aiDefaultModel} onChange={(event) => save({ aiDefaultModel: event.target.value })}>
          {BUILTIN_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
      </div>

      <label className="openray-settings-form-label" htmlFor="ai-quick-model">
        Quick AI Model
      </label>
      <div className="openray-form-field">
        <select id="ai-quick-model" value={settings.aiQuickModel} onChange={(event) => save({ aiQuickModel: event.target.value })}>
          <option value="">Follow default model</option>
          {BUILTIN_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
      </div>

      <p className="openray-settings-form-note">
        Provider API keys, AI Commands, Agents, and MCP Servers are managed from root search — run "AI Providers", "Search AI
        Commands", "Create Agent", or "Manage MCP Servers".
      </p>

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label" htmlFor="ai-profile">
        Personalization — Profile
      </label>
      <div className="openray-form-field">
        <textarea
          id="ai-profile"
          className="openray-form-textarea"
          rows={3}
          value={settings.aiProfile}
          onChange={(event) => save({ aiProfile: event.target.value })}
          placeholder="Your role, preferred language, communication style — shared with every chat."
        />
      </div>

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label openray-settings-form-label--top">Skills</label>
      <div className="openray-settings-control-stack">
        <StringListField
          id="ai-skill-dirs"
          directory
          placeholder="~/.claude/skills"
          hint="Directories scanned (top level only) for SKILL.md files."
          values={settings.aiSkillDirs}
          onChange={(values) => save({ aiSkillDirs: values })}
        />
      </div>
    </div>
  )
}
