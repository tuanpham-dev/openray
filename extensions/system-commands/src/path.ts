import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// Mirrors native `binary_exists`'s cache: PATH doesn't change during a
// run, and the listing re-probes on every `refreshRootCommands()` call.
const cache = new Map<string, boolean>()

export function binaryExists(bin: string): boolean {
  const cached = cache.get(bin)
  if (cached !== undefined) return cached
  const pathEnv = process.env.PATH ?? ''
  const exists = pathEnv.split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, bin)))
  cache.set(bin, exists)
  return exists
}
