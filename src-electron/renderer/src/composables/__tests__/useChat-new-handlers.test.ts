import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { ServerMessage } from '@xyz-agent/shared'

/**
 * Task 4: ChatStore Fields + useChat Handlers (FR-8, FR-9)
 *
 * Verifies:
 *  - 11 new event handlers in createGlobalHandlers() route to the right
 *    ChatStore methods (or external API for setTitle)
 *  - All handlers respect session isolation (no sid → no-op)
 *  - ChatStore: new fields default to undefined
 *  - ChatStore: set/clear round-trip
 *  - ChatStore: removeSession cleans up
 *
 * Strategy:
 *  - Use REAL Pinia + REAL ChatStore so state assertions are end-to-end
 *    (handler fires → store mutates → read state back).
 *  - Mock event-bus to CAPTURE registered handlers, then invoke them
 *    directly with synthetic ServerMessage payloads.
 *  - Mock session-store to provide a mutable `sessions` array (so
 *    onSessionRenamed can be observed). useChat() still imports
 *    useSessionStore from the real module, but the mock returns a
 *    controlled object.
 */

// ── Mock event-bus (capture handlers) ─────────────────────────────

type EventHandler = (msg: ServerMessage) => void
const { capturedHandlers } = vi.hoisted(() => ({
  // event-bus.on 的 handler 捕获表：用 hoisted 避免 vi.mock factory 在 import 阶段
  // 执行时（useChat → api → transport → on）触发 TDZ。mock factory 可安全引用。
  capturedHandlers: new Map<string, EventHandler>(),
}))

vi.mock('../../lib/event-bus', () => ({
  on: (event: string, handler: EventHandler) => {
    capturedHandlers.set(event, handler)
  },
  off: vi.fn(),
  emit: vi.fn(),
  clear: vi.fn(),
}))

vi.mock('../../lib/ws-client', () => ({
  send: vi.fn(),
  getState: vi.fn(() => ({ value: 'connected' })),
}))

// api singleton 会被 useChat 间接拉入；mock 掉避免真 transport + ws 依赖
vi.mock('../../api', () => ({
  api: {
    events: {
      on: (event: string, handler: EventHandler) => { capturedHandlers.set(event, handler); return () => {} },
      onConnectionRestored: vi.fn(() => () => {}),
      _dispatch: vi.fn(),
      _notifyConnectionRestored: vi.fn(),
    },
    chat: { send: vi.fn(() => Promise.resolve()), abort: vi.fn(() => Promise.resolve()), steer: vi.fn(), followUp: vi.fn() },
  },
}))

// ── Mock session store (mutable sessions for rename test) ─────────

let mockSessions: Array<{ id: string; label: string; cwd: string }>

vi.mock('../../stores/session', () => ({
  useSessionStore: () => ({
    get currentSessionId() { return 's1' },
    get sessions() { return mockSessions },
    renameSession(id: string, label: string) {
      const idx = mockSessions.findIndex(s => s.id === id)
      if (idx >= 0) mockSessions[idx] = { ...mockSessions[idx], label }
    },
  }),
}))

// Now import the module under test and the real ChatStore.
// IMPORTANT: imports must come AFTER vi.mock calls. Vitest hoists
// vi.mock, but static imports of source files still need to be below
// the mock declarations for clarity.
import { useChat } from '../useChat'
import { __test_registerGlobalHandlers } from './test-utils'
import { useChatStore } from '../../stores/chat'
import type { SystemNotification } from '../../stores/chat'

// ── Test helpers ───────────────────────────────────────────────────

function makeMsg(
  type: ServerMessage['type'],
  payload: Record<string, unknown> = {},
): ServerMessage {
  return { type, payload }
}

function invokeHandler(type: string, msg: ServerMessage): void {
  const handler = capturedHandlers.get(type)
  if (!handler) {
    throw new Error(`No handler captured for event "${type}". Captured: ${Array.from(capturedHandlers.keys()).join(', ')}`)
  }
  handler(msg)
}

/** Invoke handler and return the first system notification from store */
function invokeAndGetNotification(
  eventType: ServerMessage['type'],
  payload: Record<string, unknown>,
  sid = 's1',
): SystemNotification {
  const store = useChatStore()
  invokeHandler(eventType, makeMsg(eventType, { sessionId: sid, ...payload }))
  const msgs = store.getSessionState(sid).completedMessages
  expect(msgs).toHaveLength(1)
  return msgs[0] as SystemNotification
}

// ── Setup / Teardown ───────────────────────────────────────────────

let originalElectronAPI: unknown

beforeAll(() => {
  originalElectronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI
})

afterEach(() => {
  if (originalElectronAPI === undefined) {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  } else {
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = originalElectronAPI
  }
  vi.restoreAllMocks()
})

beforeEach(() => {
  // Fresh Pinia + real store for every test
  setActivePinia(createPinia())
  // Fresh mutable session list
  mockSessions = [
    { id: 's1', label: 'old-name', cwd: '/' },
    { id: 's2', label: 'other', cwd: '/' },
  ]
  // Clear captured handlers
  capturedHandlers.clear()
  // Trigger global handler registration against the new Pinia.
  // The auto-registration microtask in useChat.ts fires too early in
  // test env (before Pinia is active), so we call the test helper
  // explicitly. The helper is idempotent.
  __test_registerGlobalHandlers()
})

// ── Tests ──────────────────────────────────────────────────────────

describe('Task 4 — handler routing (FR-8, FR-9)', () => {
  it('onSetEditorText routes to store.setPendingEditorText', () => {
    const store = useChatStore()
    invokeHandler(
      'extension:setEditorText',
      makeMsg('extension:setEditorText', { sessionId: 's1', text: 'hi' }),
    )
    expect(store.getSessionState('s1').pendingEditorText).toBe('hi')
  })

  it('onBashExecution adds a system message', () => {
    const msg = invokeAndGetNotification('message.bashExecution', { command: 'ls', output: 'file' })
    expect(msg.role).toBe('system')
    expect(msg.notificationType).toBeDefined()
  })

  it('onCompactionSummary adds a system message', () => {
    invokeAndGetNotification('message.compactionSummary', { summary: 'compacted' })
  })

  it('onBranchSummary adds a system message', () => {
    invokeAndGetNotification('message.branchSummary', { branch: 'feature' })
  })

  it('onAutoRetryStart sets active AutoRetryState', () => {
    const store = useChatStore()
    invokeHandler(
      'message.auto_retry_start',
      makeMsg('message.auto_retry_start', {
        sessionId: 's1',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'boom',
      }),
    )
    const state = store.getSessionState('s1').autoRetryState
    expect(state).toBeDefined()
    expect(state?.active).toBe(true)
    expect(state?.attempt).toBe(2)
    expect(state?.maxAttempts).toBe(3)
    expect(state?.delayMs).toBe(1000)
    expect(state?.errorMessage).toBe('boom')
  })

  it('onAutoRetryEnd clears AutoRetryState (undefined)', () => {
    const store = useChatStore()
    // Pre-set
    store.setAutoRetryState({ active: true, attempt: 1, maxAttempts: 3, delayMs: 100 }, 's1')
    expect(store.getSessionState('s1').autoRetryState?.active).toBe(true)

    invokeHandler(
      'message.auto_retry_end',
      makeMsg('message.auto_retry_end', { sessionId: 's1' }),
    )
    expect(store.getSessionState('s1').autoRetryState).toBeUndefined()
  })

  it('onQueueUpdate sets QueueState from steering/followUp', () => {
    const store = useChatStore()
    invokeHandler(
      'message.queue_update',
      makeMsg('message.queue_update', {
        sessionId: 's1',
        steering: ['m1', 'm2'],
        followUp: ['f1'],
      }),
    )
    const qs = store.getSessionState('s1').queueState
    expect(qs).toEqual({ steering: ['m1', 'm2'], followUp: ['f1'] })
  })

  it('onQueueUpdate defaults missing arrays to empty', () => {
    const store = useChatStore()
    invokeHandler(
      'message.queue_update',
      makeMsg('message.queue_update', { sessionId: 's1', steering: ['m1'] }),
    )
    const qs = store.getSessionState('s1').queueState
    expect(qs?.steering).toEqual(['m1'])
    expect(qs?.followUp).toEqual([])
  })

  it('onSessionRenamed updates the session store entry', () => {
    invokeHandler(
      'session.renamed',
      makeMsg('session.renamed', { sessionId: 's1', name: 'new' }),
    )
    const s1 = mockSessions.find((s) => s.id === 's1')
    expect(s1?.label).toBe('new')
    // Other session untouched
    const s2 = mockSessions.find((s) => s.id === 's2')
    expect(s2?.label).toBe('other')
  })

  it('onSessionRenamed is a no-op when session is not in the list', () => {
    const before = mockSessions.map((s) => ({ ...s }))
    invokeHandler(
      'session.renamed',
      makeMsg('session.renamed', { sessionId: 'ghost', name: 'x' }),
    )
    expect(mockSessions).toEqual(before)
  })

  it('onThinkingLevelSet sets the level on the store', () => {
    const store = useChatStore()
    invokeHandler(
      'session.thinkingLevelSet',
      makeMsg('session.thinkingLevelSet', { sessionId: 's1', level: 'high' }),
    )
    expect(store.getSessionState('s1').thinkingLevel).toBe('high')
  })

  it('onExtensionSetTitle — handler removed (setTitle not implemented in preload)', () => {
    // setTitle was never implemented in preload.ts; the handler and protocol type
    // have been removed. The event is no longer registered.
    const setTitle = vi.fn()
    ;(window as unknown as { electronAPI: { setTitle: typeof setTitle } }).electronAPI = { setTitle }

    // extension:setTitle is no longer in the handler map — invokeHandler throws
    expect(() => {
      invokeHandler('extension:setTitle', makeMsg('extension:setTitle', { title: 'Win' }))
    }).toThrow(/No handler captured/)
    expect(setTitle).not.toHaveBeenCalled()
  })

  it('onStreamError adds an alert system message', () => {
    const msg = invokeAndGetNotification('message.stream_error', { content: 'fail' })
    expect(msg.role).toBe('system')
    expect(msg.notificationType).toBe('alert')
  })
})

describe('Task 4 — session isolation', () => {
  it('handlers skip routing when sessionId is missing', () => {
    const store = useChatStore()
    invokeHandler(
      'message.auto_retry_start',
      makeMsg('message.auto_retry_start', {}),
    )
    // No state should have been set for any session
    expect(store.getSessionState('any').autoRetryState).toBeUndefined()
  })

  it('onSetEditorText skips when sessionId missing', () => {
    const store = useChatStore()
    invokeHandler('extension:setEditorText', makeMsg('extension:setEditorText', { text: 'orphan' }))
    expect(store.getSessionState('any').pendingEditorText).toBeUndefined()
  })

  it('onThinkingLevelSet skips when sessionId missing', () => {
    const store = useChatStore()
    invokeHandler('session.thinkingLevelSet', makeMsg('session.thinkingLevelSet', { level: 'low' }))
    expect(store.getSessionState('any').thinkingLevel).toBeUndefined()
  })

  it('onSessionRenamed skips when sessionId missing', () => {
    const before = mockSessions.map((s) => ({ ...s }))
    invokeHandler('session.renamed', makeMsg('session.renamed', { name: 'x' }))
    expect(mockSessions).toEqual(before)
  })

  it('onStreamError skips when sessionId missing', () => {
    const store = useChatStore()
    invokeHandler('message.stream_error', makeMsg('message.stream_error', { content: 'fail' }))
    // No message should be added to the default session
    expect(store.getSessionState('s1').completedMessages).toHaveLength(0)
  })
})

describe('Task 4 — ChatStore state (real Pinia)', () => {
  it('new fields default to undefined for a fresh session', () => {
    const store = useChatStore()
    const state = store.getSessionState('new')
    expect(state.pendingEditorText).toBeUndefined()
    expect(state.autoRetryState).toBeUndefined()
    expect(state.queueState).toBeUndefined()
    expect(state.thinkingLevel).toBeUndefined()
    expect(state.responseModel).toBeUndefined()
  })

  it('setAutoRetryState round-trip: set then clear', () => {
    const store = useChatStore()
    store.setAutoRetryState(
      { active: true, attempt: 1, maxAttempts: 3, delayMs: 500 },
      's1',
    )
    expect(store.getSessionState('s1').autoRetryState?.active).toBe(true)
    expect(store.getSessionState('s1').autoRetryState?.attempt).toBe(1)

    store.setAutoRetryState(undefined, 's1')
    expect(store.getSessionState('s1').autoRetryState).toBeUndefined()
  })

  it('setPendingEditorText round-trip', () => {
    const store = useChatStore()
    store.setPendingEditorText('draft', 's1')
    expect(store.getSessionState('s1').pendingEditorText).toBe('draft')
    store.setPendingEditorText(undefined, 's1')
    expect(store.getSessionState('s1').pendingEditorText).toBeUndefined()
  })

  it('setQueueState round-trip', () => {
    const store = useChatStore()
    const q = { steering: ['x'], followUp: [] }
    store.setQueueState(q, 's1')
    expect(store.getSessionState('s1').queueState).toEqual(q)
    store.setQueueState(undefined, 's1')
    expect(store.getSessionState('s1').queueState).toBeUndefined()
  })

  it('setThinkingLevel and setResponseModel round-trip', () => {
    const store = useChatStore()
    store.setThinkingLevel('medium', 's1')
    store.setResponseModel('claude-opus', 's1')
    let state = store.getSessionState('s1')
    expect(state.thinkingLevel).toBe('medium')
    expect(state.responseModel).toBe('claude-opus')

    store.setThinkingLevel(undefined, 's1')
    store.setResponseModel(undefined, 's1')
    state = store.getSessionState('s1')
    expect(state.thinkingLevel).toBeUndefined()
    expect(state.responseModel).toBeUndefined()
  })

  it('removeSession cleans up the entire state partition including new fields', () => {
    const store = useChatStore()
    // Set all new fields
    store.setPendingEditorText('draft', 's1')
    store.setAutoRetryState({ active: true, attempt: 1, maxAttempts: 3, delayMs: 100 }, 's1')
    store.setQueueState({ steering: ['m'], followUp: [] }, 's1')
    store.setThinkingLevel('low', 's1')
    store.setResponseModel('gpt-4', 's1')
    expect(store.getSessionState('s1').pendingEditorText).toBe('draft')

    store.removeSession('s1')
    // After remove, getSessionState auto-creates a fresh partition —
    // the new fields should all be undefined again.
    const fresh = store.getSessionState('s1')
    expect(fresh.pendingEditorText).toBeUndefined()
    expect(fresh.autoRetryState).toBeUndefined()
    expect(fresh.queueState).toBeUndefined()
    expect(fresh.thinkingLevel).toBeUndefined()
    expect(fresh.responseModel).toBeUndefined()
  })
})
