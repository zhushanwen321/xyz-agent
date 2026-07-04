import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PendingTracker } from '../src/utils/async/pending-tracker.js'

describe('PendingTracker', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('register() resolves with value when resolve() is called', async () => {
    const tracker = new PendingTracker<number, string>()
    const p = tracker.register(1, 1000, new Error('timeout'))
    tracker.resolve(1, 'ok')
    await expect(p).resolves.toBe('ok')
  })

  it('register() rejects with the provided timeoutError on timeout', async () => {
    const tracker = new PendingTracker<number, string>()
    const timeoutErr = Object.assign(new Error('RPC timeout'), { code: 42 })
    const p = tracker.register(1, 1000, timeoutErr)
    vi.advanceTimersByTime(1000)
    await expect(p).rejects.toMatchObject({ message: 'RPC timeout', code: 42 })
  })

  it('resolve() returns false when key is not registered (not a hit)', () => {
    const tracker = new PendingTracker<number, string>()
    expect(tracker.resolve(99, 'x')).toBe(false)
  })

  it('reject() rejects the promise and returns true on hit', async () => {
    const tracker = new PendingTracker<string, number>()
    const p = tracker.register('a', 1000, new Error('timeout'))
    const replyErr = Object.assign(new Error('bad request'), { code: -32600 })
    expect(tracker.reject('a', replyErr)).toBe(true)
    await expect(p).rejects.toMatchObject({ message: 'bad request', code: -32600 })
  })

  it('reject() returns false when key is not registered', () => {
    const tracker = new PendingTracker<string, number>()
    expect(tracker.reject('nope', new Error('x'))).toBe(false)
  })

  it('resolve() clears the timeout (no late rejection)', async () => {
    const tracker = new PendingTracker<number, string>()
    const p = tracker.register(1, 1000, new Error('timeout'))
    tracker.resolve(1, 'ok')
    vi.advanceTimersByTime(5000) // well past timeout
    await expect(p).resolves.toBe('ok')
  })

  it('rejectAll() rejects every registered promise and clears the map', async () => {
    const tracker = new PendingTracker<number, string>()
    const p1 = tracker.register(1, 1000, new Error('timeout'))
    const p2 = tracker.register(2, 2000, new Error('timeout'))
    expect(tracker.size).toBe(2)

    tracker.rejectAll(new Error('disposed'))

    await expect(p1).rejects.toThrow('disposed')
    await expect(p2).rejects.toThrow('disposed')
    expect(tracker.size).toBe(0)
  })

  it('rejectAll() clears timeouts (no double-reject after)', async () => {
    const tracker = new PendingTracker<number, string>()
    const p = tracker.register(1, 1000, new Error('timeout'))
    tracker.rejectAll(new Error('disposed'))
    vi.advanceTimersByTime(5000)
    // promise already settled as 'disposed', not the timeout error
    await expect(p).rejects.toThrow('disposed')
    expect(tracker.size).toBe(0)
  })

  it('handles concurrent out-of-order resolution by key', async () => {
    const tracker = new PendingTracker<number, string>()
    const promises = [
      tracker.register(1, 1000, new Error('t')),
      tracker.register(2, 1000, new Error('t')),
      tracker.register(3, 1000, new Error('t')),
    ]
    tracker.resolve(3, 'C')
    tracker.resolve(1, 'A')
    tracker.resolve(2, 'B')
    await expect(Promise.all(promises)).resolves.toEqual(['A', 'B', 'C'])
  })

  it('number and string keys both work as generic K', async () => {
    const numT = new PendingTracker<number, string>()
    const strT = new PendingTracker<string, string>()
    const pn = numT.register(1, 100, new Error('t'))
    const ps = strT.register('id-1', 100, new Error('t'))
    numT.resolve(1, 'n')
    strT.resolve('id-1', 's')
    await expect(pn).resolves.toBe('n')
    await expect(ps).resolves.toBe('s')
  })
})
