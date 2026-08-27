import { useEffect } from 'react'

/** A trivial second command — proves two distinct commands can be mounted
 * concurrently without one's mount tearing down the other's (T9). */
export default function SimpleCommand(): null {
  useEffect(() => {
    const events = ((globalThis as Record<string, unknown>).__fixtureEvents ??= []) as string[]
    events.push('simple:mount')
    return () => {
      events.push('simple:unmount')
    }
  }, [])

  return null
}
