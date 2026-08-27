import { useEffect } from 'react'

/**
 * Records mount/tick/unmount into a globalThis side channel so the test
 * (running in the same process) can observe lifecycle events without a real
 * UI assertion — this fixture's whole purpose is proving T9's timer-cleanup
 * behavior, not rendering anything.
 */
export default function IntervalCommand(): null {
  useEffect(() => {
    const events = ((globalThis as Record<string, unknown>).__fixtureEvents ??= []) as string[]
    events.push('interval:mount')
    const timer = setInterval(() => {
      events.push('interval:tick')
    }, 10)
    return () => {
      clearInterval(timer)
      events.push('interval:unmount')
    }
  }, [])

  return null
}
