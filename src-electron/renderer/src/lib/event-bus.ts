import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'

type EventHandler = (msg: ServerMessage) => void

// Internal storage remains keyed by string for backward compatibility with
// any code paths that may still register using non-server-message identifiers
// at runtime. The public API is strictly typed to ServerMessageType.
const listeners = new Map<string, Set<EventHandler>>()

export function on(event: ServerMessageType, handler: EventHandler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event)!.add(handler)
  return () => listeners.get(event)?.delete(handler)
}

export function off(event: ServerMessageType, handler: EventHandler): void {
  listeners.get(event)?.delete(handler)
}

export function emit(event: ServerMessageType, msg: ServerMessage): void {
  // Cast to string for map lookup — internal storage uses string keys
  // while the public API is restricted to ServerMessageType values
  // (which are a string-literal union, structurally compatible with string).
  const key = event as string
  listeners.get(key)?.forEach(h => {
    try {
      h(msg)
    // eslint-disable-next-line taste/no-silent-catch -- intentional: one handler must not break all others
    } catch (e) {
      console.error(`[event-bus] handler error for event "${event}":`, e)
    }
  })
}

export function clear(): void {
  listeners.clear()
}
