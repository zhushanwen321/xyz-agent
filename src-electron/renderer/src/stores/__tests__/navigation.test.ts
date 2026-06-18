import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useNavigationStore } from '../navigation'

describe('useNavigationStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts with empty stack', () => {
    const store = useNavigationStore()
    expect(store.currentEntry).toBeNull()
    expect(store.canGoBack).toBe(false)
    expect(store.canGoForward).toBe(false)
    expect(store.pointer).toBe(-1)
    expect(store.entries).toHaveLength(0)
  })

  it('AC-1: basic navigation sequence', () => {
    const store = useNavigationStore()

    store.push({ view: 'chat', sessionId: 'A' })
    expect(store.pointer).toBe(0)
    expect(store.currentEntry!.sessionId).toBe('A')

    store.push({ view: 'chat', sessionId: 'B' })
    expect(store.pointer).toBe(1)

    store.back()
    expect(store.pointer).toBe(0)
    expect(store.currentEntry!.sessionId).toBe('A')

    store.forward()
    expect(store.pointer).toBe(1)
    expect((store.currentEntry as { sessionId: string }).sessionId).toBe('B')
  })

  it('AC-2: truncates forward branch on push', () => {
    const store = useNavigationStore()

    store.push({ view: 'chat', sessionId: '1' })
    store.push({ view: 'chat', sessionId: '2' })
    store.push({ view: 'chat', sessionId: '3' })

    store.back() // pointer=1
    expect(store.pointer).toBe(1)

    store.push({ view: 'chat', sessionId: '4' })

    // Entry 3 truncated, new entry appended
    expect(store.entries).toHaveLength(3)
    expect(store.pointer).toBe(2)
    expect(store.canGoForward).toBe(false)
  })

  it('AC-4: caps at 50 entries, evicting oldest', () => {
    const store = useNavigationStore()

    for (let i = 0; i < 51; i++) {
      store.push({ view: 'chat', sessionId: `s${i}` })
    }

    expect(store.entries).toHaveLength(50)
    expect(store.pointer).toBe(49)
    // Oldest entry s0 was evicted; first entry is now s1
    expect((store.entries[0] as { sessionId: string }).sessionId).toBe('s1')
    expect(store.currentEntry!.sessionId).toBe('s50')
  })

  it('back/forward are no-op on empty stack', () => {
    const store = useNavigationStore()

    store.back()
    expect(store.pointer).toBe(-1)
    store.forward()
    expect(store.pointer).toBe(-1)
  })

  it('back is no-op when pointer=0 (first entry)', () => {
    const store = useNavigationStore()

    store.push({ view: 'chat', sessionId: 'A' })
    store.push({ view: 'chat', sessionId: 'B' })
    expect(store.pointer).toBe(1)

    // Back to first entry
    store.back()
    expect(store.pointer).toBe(0)
    expect(store.canGoBack).toBe(false)
    expect(store.canGoForward).toBe(true)
    expect(store.entries).toHaveLength(2)

    // Back at pointer=0 is no-op
    store.back()
    expect(store.pointer).toBe(0)
    expect(store.entries).toHaveLength(2)
  })

  it('reset clears entire stack regardless of state', () => {
    const store = useNavigationStore()

    store.push({ view: 'chat', sessionId: 'A' })
    expect(store.pointer).toBe(0)
    expect(store.canGoBack).toBe(false)

    // reset() clears the stack even when canGoBack is false
    store.reset()
    expect(store.pointer).toBe(-1)
    expect(store.entries).toHaveLength(0)
    expect(store.canGoForward).toBe(false)
  })
})
