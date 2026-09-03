/**
 * Drains react-reconciler's scheduled work, for tests that mount a tree and
 * then read what it committed.
 *
 * Nothing the reconciler does is synchronous, and it is not one hop either:
 * a render is queued as a microtask that in turn schedules the commit on
 * `setImmediate`, and a state update from a previous test's root can still be
 * pending when the next one mounts. A single turn therefore only *usually*
 * lands the commit — it wins the race on an idle machine and loses it on a
 * busy one, which is what made `reconciler.test.ts` fail when the whole
 * workspace ran its suites at once while passing on its own: the tests read
 * an empty tree and blamed the node that "wasn't there".
 *
 * Extra turns cost nothing. Each resolves as soon as the event loop is free,
 * and they queue behind whatever the reconciler scheduled rather than racing
 * it, so the work is drained rather than merely waited on.
 */
export async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}
