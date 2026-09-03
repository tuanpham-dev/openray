import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'

type Handler<T> = (payload: T) => void
type AnyHandler = Handler<unknown>

const subscribers = new Map<string, Set<AnyHandler>>()

/**
 * Subscribes to an event the Rust side emits.
 *
 * One native Tauri listener is registered per event name and fans out to
 * every subscriber; subscribing and unsubscribing after that is local and
 * synchronous. The obvious alternative — a `listen()` per subscriber,
 * unlistened on teardown — races. Tauri's `listen` command hands back the
 * listener id as soon as Rust has it, but the bookkeeping that puts that id
 * in the webview is a *separate* `eval`, so an unlisten issued in the same
 * tick as the listen can arrive before the id exists and throw on the entry
 * it can't find (`listeners[eventId].handlerId`). React's StrictMode does
 * exactly that on every mount in development — effect, cleanup, effect —
 * which is where the startup console's unhandled rejections came from. The
 * throw also happened *before* the unlisten it was meant to precede, so each
 * one left a listener registered on the Rust side into the bargain.
 *
 * Never unlistening sidesteps the race rather than timing around it, and
 * leaks nothing: it is one listener per event name for as long as the
 * webview lives, and Tauri drops a webview's listeners with the webview.
 */
export function subscribeEvent<T>(event: string, handler: Handler<T>): () => void {
  const wrapped = handler as AnyHandler
  let handlers = subscribers.get(event)
  if (!handlers) {
    handlers = new Set()
    subscribers.set(event, handlers)
    void listen<T>(event, ({ payload }) => {
      // Snapshotted before dispatch: a handler is free to unsubscribe itself
      // (or a sibling) while the event is being delivered.
      const current = Array.from(subscribers.get(event) ?? [])
      for (const subscriber of current) subscriber(payload)
    })
  }
  handlers.add(wrapped)
  return () => {
    handlers.delete(wrapped)
  }
}

/**
 * `subscribeEvent` for a component. The handler is read fresh on every
 * event, so it can close over current props and state without the
 * subscription being torn down and rebuilt whenever those change.
 */
export function useAppEvent<T>(event: string, handler: Handler<T>): void {
  const latest = useRef(handler)
  latest.current = handler

  useEffect(() => subscribeEvent<T>(event, (payload) => latest.current(payload)), [event])
}
