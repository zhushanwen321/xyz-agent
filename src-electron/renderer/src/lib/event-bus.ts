import type { ServerMessage, ServerMessageType } from '@xyz-agent/shared'

type TypedHandler = (msg: ServerMessage) => void

// Internal storage keyed by string for backward compatibility with code paths
// that register non-ServerMessage event identifiers at runtime.
const listeners = new Map<string, Set<TypedHandler>>()

/**
 * Subscribe to a typed server event.
 * The handler receives a ServerMessage with payload typed as Record<string, unknown>.
 */
export function on(event: ServerMessageType, handler: TypedHandler): () => void
/**
 * Subscribe to an untyped event (backward compat for non-ServerMessage events).
 * The handler may receive any shape of message object.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function on(event: string, handler: (msg: any) => void): () => void
export function on(event: string, handler: TypedHandler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event)!.add(handler)
  return () => listeners.get(event)?.delete(handler)
}

export function off(event: ServerMessageType, handler: TypedHandler): void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function off(event: string, handler: (msg: any) => void): void
export function off(event: string, handler: TypedHandler): void {
  listeners.get(event)?.delete(handler)
}

export function emit(event: ServerMessageType, msg: ServerMessage): void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function emit(event: string, msg?: any): void
export function emit(event: string, msg?: ServerMessage): void {
  listeners.get(event)?.forEach(h => {
    try {
      h(msg as ServerMessage)
    // eslint-disable-next-line taste/no-silent-catch -- intentional: one handler must not break all others
    } catch (e) {
      console.error(`[event-bus] handler error for event "${event}":`, e)
    }
  })
}

export function clear(): void {
  listeners.clear()
}
