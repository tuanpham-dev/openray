import { useEffect, useState } from 'react'
import { Toggle } from './Toggle'
import {
  addRegistrySource,
  listRegistrySources,
  removeRegistrySource,
  setRegistrySourceAutoUpdate,
  setRegistrySourceEnabled,
  type RegistrySource,
} from '../../ipc/registry'

/**
 * Managing which registries extensions may be installed from.
 *
 * Adding one is the trust decision this whole feature rests on: a registry
 * serves unsigned archives that run in the extension host with the user's
 * own privileges, and — with auto-update on — newer versions arrive without
 * anyone clicking anything. So adding asks for confirmation in those words,
 * and auto-update is switchable per source rather than globally, because
 * trusting the default registry is not the same as trusting a link someone
 * sent you.
 */
export function RegistriesSection() {
  const [sources, setSources] = useState<RegistrySource[]>([])
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => listRegistrySources().then(setSources)

  useEffect(() => {
    void refresh()
  }, [])

  const add = async () => {
    const value = url.trim()
    if (!value) return
    const confirmed = window.confirm(
      `Add ${value} as a registry?\n\nExtensions installed from a registry run with the same access you have — they are not sandboxed, and OpenRay cannot verify who published them. With automatic updates on, new versions install without asking.\n\nOnly add registries you trust.`,
    )
    if (!confirmed) return

    setAdding(true)
    setError(null)
    try {
      // The backend fetches the catalog first, so a URL that serves nothing
      // usable never becomes a stored source.
      await addRegistrySource(value)
      setUrl('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const remove = async (source: RegistrySource) => {
    if (!window.confirm(`Remove ${source.name ?? source.url}?\n\nExtensions already installed from it stay installed, but stop receiving updates.`)) {
      return
    }
    await removeRegistrySource(source.url)
    await refresh()
  }

  const toggleEnabled = (source: RegistrySource, enabled: boolean) => {
    setSources((current) => current.map((item) => (item.url === source.url ? { ...item, enabled } : item)))
    void setRegistrySourceEnabled(source.url, enabled)
  }

  const toggleAutoUpdate = (source: RegistrySource, autoUpdate: boolean) => {
    setSources((current) => current.map((item) => (item.url === source.url ? { ...item, autoUpdate } : item)))
    void setRegistrySourceAutoUpdate(source.url, autoUpdate)
  }

  return (
    <>
      <p className="openray-extensions-install-hint">
        A registry is any URL serving an <code>index.json</code> catalog and one archive per extension — a GitHub Pages site,
        a plain web server, or a local folder. Browse what they offer with the Store command.
      </p>
      <div className="openray-extensions-install">
        <input
          type="text"
          placeholder="https://example.github.io/openray-extensions/"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={adding}
        />
        <button type="button" onClick={() => void add()} disabled={adding || !url.trim()}>
          {adding ? 'Checking…' : 'Add Registry'}
        </button>
      </div>
      {error && <p className="openray-extensions-install-error">{error}</p>}

      {sources.length > 0 && (
        <ul className="openray-registry-list">
          {sources.map((source) => (
            <li key={source.url} className="openray-registry-row">
              <div className="openray-registry-row-text">
                <span className="openray-registry-row-title">{source.name ?? source.url}</span>
                <span className="openray-registry-row-url">{source.url}</span>
              </div>
              <label className="openray-registry-row-toggle">
                <span>Auto-update</span>
                <Toggle
                  id={`registry-auto-${source.url}`}
                  checked={source.autoUpdate}
                  onChange={(checked) => toggleAutoUpdate(source, checked)}
                />
              </label>
              <label className="openray-registry-row-toggle">
                <span>Enabled</span>
                <Toggle
                  id={`registry-enabled-${source.url}`}
                  checked={source.enabled}
                  onChange={(checked) => toggleEnabled(source, checked)}
                />
              </label>
              <button type="button" className="openray-extensions-uninstall" onClick={() => void remove(source)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
