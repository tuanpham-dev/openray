import { Fragment, useEffect, useState } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { Checkbox } from './Checkbox'
import { PassphrasePrompt } from './PassphrasePrompt'
import { SensitiveDataWarning } from './SensitiveDataWarning'
import {
  exportData,
  importData,
  inspectExportFile,
  inspectExportSensitivity,
  listExportCategories,
  type ExportCategory,
  type ExportScope,
  type PasswordPreference,
} from '../../ipc/transfer'

/** Mirrors the defaults the retired Cloud Sync settings carried: clipboard
 *  history is the most privacy-sensitive category, so it stays opt-in.
 *  Extensions start fully selected, which `all: true` expresses directly. */
const DEFAULT_SCOPE: ExportScope = { core: true, extensions: { all: true, ids: [] }, clipboard: false, usage: true }

/** The export flow is a short sequence of modals over one chosen path:
 *  warn about credentials (only if there are any), then ask about a
 *  passphrase. Each step carries the path and the answers before it. */
type Step =
  | { kind: 'warn'; path: string; credentials: PasswordPreference[] }
  | { kind: 'passphrase'; path: string; includePasswords: boolean }
  | { kind: 'import-passphrase'; path: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeFailures(failures: [string, string][]): string {
  return failures.map(([id, message]) => `${id} (${message})`).join(', ')
}

export function ImportExportPane() {
  const [categories, setCategories] = useState<ExportCategory[]>([])
  const [scope, setScope] = useState<ExportScope>(DEFAULT_SCOPE)
  const [step, setStep] = useState<Step | null>(null)
  const [stepError, setStepError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Read once on mount. Installing an extension while this pane is open
  // won't add its row until the pane is revisited, which is an accepted
  // trade for not holding a live subscription open.
  useEffect(() => {
    void listExportCategories()
      .then(setCategories)
      .catch((err: unknown) => setError(errorMessage(err)))
  }, [])

  const selectedIds = scope.extensions.all ? categories.map((c) => c.id) : scope.extensions.ids
  const allSelected = categories.length > 0 && selectedIds.length === categories.length
  const someSelected = selectedIds.length > 0 && !allSelected

  const setExtensions = (ids: string[]) => {
    // Collapse "every child checked" back to `all`, so the scope keeps
    // meaning "whatever is installed" rather than freezing today's list.
    const all = categories.length > 0 && ids.length === categories.length
    setScope({ ...scope, extensions: { all, ids: all ? [] : ids } })
  }

  const toggleExtension = (id: string, checked: boolean) => {
    setExtensions(checked ? [...selectedIds, id] : selectedIds.filter((existing) => existing !== id))
  }

  const begin = () => {
    setStatus(null)
    setError(null)
  }

  const handleExportClick = () => {
    begin()
    void save({ defaultPath: 'openray-export.json', filters: [{ name: 'OpenRay export', extensions: ['json'] }] })
      .then(async (path) => {
        if (!path) return
        setStepError(null)
        // Ask about credentials before anything is written — and skip the
        // question entirely when the scope contains none.
        const credentials = await inspectExportSensitivity(scope.extensions)
        setStep(credentials.length > 0 ? { kind: 'warn', path, credentials } : { kind: 'passphrase', path, includePasswords: false })
      })
      .catch((err: unknown) => setError(errorMessage(err)))
  }

  const runExport = (path: string, passphrase: string | null, includePasswords: boolean) => {
    setBusy(true)
    setStepError(null)
    exportData(path, passphrase, scope, includePasswords)
      .then((summary) => {
        setStep(null)
        const exported = summary.extensionsExported.length
        const parts = [`Exported to ${path}`]
        if (exported > 0) parts.push(`${exported} extension${exported === 1 ? '' : 's'} included`)
        if (summary.failures.length > 0) parts.push(`failed: ${describeFailures(summary.failures)}`)
        setStatus(parts.join(' — '))
      })
      .catch((err: unknown) => setStepError(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  const handleImportClick = () => {
    begin()
    void open({ multiple: false, directory: false, filters: [{ name: 'OpenRay export', extensions: ['json'] }] })
      .then((path) => {
        if (typeof path !== 'string') return
        setBusy(true)
        return inspectExportFile(path)
          .then((info) => {
            if (info.encrypted) {
              setStepError(null)
              setStep({ kind: 'import-passphrase', path })
              return
            }
            return runImport(path, null)
          })
          .finally(() => setBusy(false))
      })
      .catch((err: unknown) => setError(errorMessage(err)))
  }

  const runImport = (path: string, passphrase: string | null) => {
    setBusy(true)
    setStepError(null)
    return importData(path, passphrase)
      .then((summary) => {
        setStep(null)
        const records = `${summary.recordsApplied} ${summary.recordsApplied === 1 ? 'item' : 'items'}`
        const parts = [`Imported ${records}`]
        if (summary.settingsApplied) parts.push('and your settings')
        if (summary.extensionsImported.length > 0) parts.push(`restored ${summary.extensionsImported.join(', ')}`)
        if (summary.skippedExtensions.length > 0) parts.push(`skipped ${summary.skippedExtensions.join(', ')} (not installed)`)
        if (summary.failures.length > 0) parts.push(`failed: ${describeFailures(summary.failures)}`)
        setStatus(`${parts.join(' — ')}.`)
      })
      .catch((err: unknown) => {
        // Keep the prompt open on a wrong passphrase so the user can just
        // retype it; an unencrypted file has no prompt to report into.
        if (passphrase === null) setError(errorMessage(err))
        else setStepError(errorMessage(err))
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="openray-settings-pane openray-settings-pane--form">
      <div className="openray-settings-form">
        <span className="openray-settings-form-label">Export</span>
        <span className="openray-settings-control-hint">
          Writes your data to a single file you can move to another machine. You&rsquo;ll be asked for a passphrase to encrypt it.
        </span>

        <label className="openray-settings-form-label" htmlFor="export-core">
          Core Data
        </label>
        <span className="openray-settings-control-group">
          <Checkbox id="export-core" checked={scope.core} onChange={(checked) => setScope({ ...scope, core: checked })} />
          <span className="openray-settings-control-hint">Command aliases and hotkeys, and your general settings</span>
        </span>

        <label className="openray-settings-form-label" htmlFor="export-extensions">
          Extensions
        </label>
        <span className="openray-settings-control-group">
          <Checkbox
            id="export-extensions"
            checked={allSelected}
            indeterminate={someSelected}
            disabled={categories.length === 0}
            onChange={(checked) => setExtensions(checked ? categories.map((c) => c.id) : [])}
          />
          <span className="openray-settings-control-hint">
            {categories.length === 0
              ? 'No installed extension offers import and export yet.'
              : 'Each extension below exports its own data.'}
          </span>
        </span>

        {/* A Fragment, so the label and control stay direct children of the
            form grid — wrapping them in an element would break the
            two-column auto-placement every other row relies on. */}
        {categories.map((category) => (
          <Fragment key={category.id}>
            <label className="openray-settings-form-label openray-settings-subrow-label" htmlFor={`export-ext-${category.id}`}>
              {category.title}
            </label>
            <span className="openray-settings-control-group">
              <Checkbox
                id={`export-ext-${category.id}`}
                checked={selectedIds.includes(category.id)}
                onChange={(checked) => toggleExtension(category.id, checked)}
              />
              {category.description && <span className="openray-settings-control-hint">{category.description}</span>}
            </span>
          </Fragment>
        ))}

        <label className="openray-settings-form-label" htmlFor="export-clipboard">
          Clipboard History
        </label>
        <span className="openray-settings-control-group">
          <Checkbox id="export-clipboard" checked={scope.clipboard} onChange={(checked) => setScope({ ...scope, clipboard: checked })} />
          <span className="openray-settings-control-hint">
            Clipboard history, text entries only — copied images stay on this machine
          </span>
        </span>

        <label className="openray-settings-form-label" htmlFor="export-usage">
          Usage Counts
        </label>
        <span className="openray-settings-control-group">
          <Checkbox id="export-usage" checked={scope.usage} onChange={(checked) => setScope({ ...scope, usage: checked })} />
          <span className="openray-settings-control-hint">Command usage counts, combined rather than overwritten when imported</span>
        </span>

        <span className="openray-settings-form-label" />
        <span className="openray-settings-control-group">
          <button type="button" className="openray-form-button openray-form-button--primary" disabled={busy} onClick={handleExportClick}>
            Export…
          </button>
        </span>

        <hr className="openray-settings-separator" />

        <span className="openray-settings-form-label">Import</span>
        <div className="openray-settings-control-stack">
          <span className="openray-settings-control-group">
            <button type="button" className="openray-form-button" disabled={busy} onClick={handleImportClick}>
              Import…
            </button>
          </span>
          <span className="openray-settings-control-hint">
            Merges an export file into this machine. Newer local edits are kept, so importing an older file never overwrites them.
            Data for an extension you don&rsquo;t have installed is skipped.
          </span>
        </div>

        {status && (
          <>
            <span className="openray-settings-form-label" />
            <span className="openray-settings-control-hint">{status}</span>
          </>
        )}
        {error && (
          <>
            <span className="openray-settings-form-label" />
            <span className="openray-hotkey-error">{error}</span>
          </>
        )}
      </div>
      <div className="openray-settings-bottom-spacer" />

      {step?.kind === 'warn' && (
        <SensitiveDataWarning
          credentials={step.credentials}
          onInclude={() => setStep({ kind: 'passphrase', path: step.path, includePasswords: true })}
          onExclude={() => setStep({ kind: 'passphrase', path: step.path, includePasswords: false })}
          onCancel={() => setStep(null)}
        />
      )}

      {step?.kind === 'passphrase' && (
        <PassphrasePrompt
          mode="export"
          error={stepError}
          busy={busy}
          onSubmit={(passphrase) => runExport(step.path, passphrase, step.includePasswords)}
          onSkip={() => runExport(step.path, null, step.includePasswords)}
          onCancel={() => {
            setStep(null)
            setStepError(null)
          }}
        />
      )}

      {step?.kind === 'import-passphrase' && (
        <PassphrasePrompt
          mode="import"
          error={stepError}
          busy={busy}
          onSubmit={(passphrase) => void runImport(step.path, passphrase)}
          onCancel={() => {
            setStep(null)
            setStepError(null)
          }}
        />
      )}
    </div>
  )
}
