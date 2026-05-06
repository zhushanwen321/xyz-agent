type EventHandler = (...args: any[]) => void

const listeners = new Map<string, Set<EventHandler>>()

export function on(event: string, handler: EventHandler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event)!.add(handler)
  return () => listeners.get(event)?.delete(handler)
}

export function off(event: string, handler: EventHandler): void {
  listeners.get(event)?.delete(handler)
}

export function emit(event: string, ...args: any[]): void {
  listeners.get(event)?.forEach(h => h(...args))
}

export function clear(): void {
  listeners.clear()
}
