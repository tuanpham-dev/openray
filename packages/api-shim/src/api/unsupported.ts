import { showToast, Toast } from './toast'

/**
 * Thrown by APIs OpenRay doesn't implement (AI, OAuth, ...) instead of
 * letting the extension crash on a raw "not a function"/stub-Proxy error.
 * Per the plan: present but degrade — a visible toast plus a typed error
 * the extension's own try/catch can distinguish from a real bug.
 */
export class UnsupportedError extends Error {
  constructor(public readonly apiName: string) {
    super(`${apiName} isn't supported in OpenRay yet`)
    this.name = 'UnsupportedError'
  }
}

async function unsupported(apiName: string): Promise<never> {
  const error = new UnsupportedError(apiName)
  await showToast({ style: Toast.Style.Failure, title: 'Unsupported feature', message: error.message }).catch(() => {})
  throw error
}

export const AI = {
  ask: () => unsupported('AI.ask'),
  Model: new Proxy(
    {},
    {
      get: () => {
        throw new UnsupportedError('AI.Model')
      },
    },
  ),
}

export const OAuth = {
  PKCEClient: class {
    constructor() {
      throw new UnsupportedError('OAuth.PKCEClient')
    }
  },
}
