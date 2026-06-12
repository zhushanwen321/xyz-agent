/* eslint-disable */
// @vitest-environment jsdom
// Run with: npx vitest run --config src-electron/renderer/vitest.config.ts src-electron/renderer/src/components/panel/__tests__/PanelSessionView-subagent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { AgentInfo, Message } from '@xyz-agent/shared'

/**
 * Integration-style tests for PanelSessionView.vue — subagent passthrough
 *
 * Verifies that when ChatPanel emits 'send' with a subagent payload,
 * PanelSessionView correctly passes it to sendMessage.
 *
 * Testing strategy: mock the composables and stores, then trigger
 * the handleSend path by having ChatPanel emit 'send'.
 */

// ── Mocks ──────────────────────────────────────────────────────────

const sendMessageMock = vi.fn()
const abortMock = vi.fn()

vi.mock('../../../composables/useChat', () => ({
  useChat: () => ({
  sendMessage: sendMessageMock,
  abort: abortMock,
  }),
}))

const addedMessages: unknown[] = []

vi.mock('../../../stores/chat', () => ({
  useChatStore: () => ({
  getSessionState: () => ({
    completedMessages: [],
    streamingMessage: null,
    isGenerating: false,
    error: null,
    agentViews: {},
    activeAgentId: 'main',
    pendingApprovals: [],
    contextUsagePercent: 0,
    contextInputTokens: 0,
    contextLimit: 100_000,
    tokenUsage: 0,
    doneCount: 0,
    alertCount: 0,
    isCompacting: false,
  }),
  allAgentOptions: [],
  setError: vi.fn(),
  addMessage: (msg: unknown) => { addedMessages.push(msg) },
  ensureSession: vi.fn(),
  switchAgent: vi.fn(),
  setGenerating: vi.fn(),
  setStreaming: vi.fn(),
  completeStreaming: vi.fn(),
  setCompacting: vi.fn(),
  }),
}))

vi.mock('../../../stores/panel', () => ({
  usePanelStore: () => ({
  panes: [],
  panelCount: 1,
  closeEmptyPanel: vi.fn(),
  unbindSession: vi.fn(),
  }),
}))

vi.mock('../../../stores/provider', () => ({
  useProviderStore: () => ({
  providers: [],
  models: [],
  skills: [],
  agents: [],
  }),
}))

vi.mock('../../../stores/settings', () => ({
  useSettingsStore: () => ({
  defaultModel: 'test/model',
  }),
}))

vi.mock('../../../lib/ws-client', () => ({
  send: vi.fn(),
}))

vi.mock('../../../lib/event-bus', () => ({
  on: vi.fn(),
  off: vi.fn(),
}))

vi.mock('../../../composables/useTree', () => ({
  useTree: () => ({
  fetchTree: vi.fn(),
  requestCapability: vi.fn(),
  }),
}))

vi.mock('../../../composables/useToolApproval', () => ({
  useToolApproval: () => ({
  pendingToolCalls: ref([]),
  approve: vi.fn(),
  deny: vi.fn(),
  alwaysAllow: vi.fn(),
  }),
}))

vi.mock('../../../composables/useModel', () => ({
  useModel: () => ({
  currentModel: ref('test/model'),
  }),
}))

// Mock ChatPanel — we just need it to forward the 'send' event
const ChatPanelStub = {
  name: 'ChatPanel',
  props: [
  'agentOptions', 'activeAgentId', 'panelId', 'sessionId',
  'agentViews', 'messages', 'streamingMessage', 'isStreaming',
  'pendingApproval', 'doneCount', 'alertCount', 'isCompacting',
  ],
  emits: ['send', 'cancel', 'select-model', 'approve', 'deny', 'always-allow', 'open-drawer', 'close-pane', 'switch-agent', 'send-command', 'local-action'],
  template: `
  <div data-chat-panel-stub>
    <button data-send-btn @click="$emit('send', sendPayload)">Send</button>
  </div>
  `,
  data() {
  return { sendPayload: null }
  },
}

import PanelSessionView from '../PanelSessionView.vue'

function mountPanel(overrides: { sessionId?: string; panelId?: string } = {}) {
  return mount(PanelSessionView, {
  props: {
    panelId: overrides.panelId ?? 'pane-1',
    sessionId: overrides.sessionId ?? 'session-1',
  },
  global: {
    stubs: {
    ChatPanel: ChatPanelStub,
    },
  },
  })
}

describe('PanelSessionView — handleSend subagent passthrough', () => {
  beforeEach(() => {
  sendMessageMock.mockClear()
  addedMessages.length = 0
  })

  it('should pass subagent payload to sendMessage when send event includes subagent', async () => {
  const wrapper = mountPanel({ sessionId: 'session-sa-1' })

  const panel = wrapper.findComponent({ name: 'ChatPanel' })
  await panel.vm.$emit('send', {
    content: 'review this code',
    subagent: { agent: 'code-reviewer', task: 'Review src/foo.ts' },
  })
  await nextTick()

  expect(sendMessageMock, 'sendMessage should be called once').toHaveBeenCalledTimes(1)
  expect(sendMessageMock).toHaveBeenCalledWith(
    'review this code',
    { agent: 'code-reviewer', task: 'Review src/foo.ts' },
  )
  })

  it('should call sendMessage with content only when send event has no subagent', async () => {
  const wrapper = mountPanel({ sessionId: 'session-plain' })

  const panel = wrapper.findComponent({ name: 'ChatPanel' })
  await panel.vm.$emit('send', { content: 'hello world' })
  await nextTick()

  expect(sendMessageMock, 'sendMessage should be called once').toHaveBeenCalledTimes(1)
  expect(sendMessageMock).toHaveBeenCalledWith('hello world', undefined)
  })

  it('should still pass through empty subagent object without crashing', async () => {
  const wrapper = mountPanel({ sessionId: 'session-empty-sa' })

  const panel = wrapper.findComponent({ name: 'ChatPanel' })
  await panel.vm.$emit('send', {
    content: 'do something',
    subagent: { agent: '', task: '' },
  })
  await nextTick()

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  expect(sendMessageMock).toHaveBeenCalledWith(
    'do something',
    { agent: '', task: '' },
  )
  })

  it('should handle subagent with undefined agent/task fields', async () => {
  const wrapper = mountPanel({ sessionId: 'session-undef-sa' })

  const panel = wrapper.findComponent({ name: 'ChatPanel' })
  // Simulate subagent with missing fields — the component doesn't validate
  await panel.vm.$emit('send', {
    content: 'unclear request',
    subagent: { agent: 'some-agent' },
  })
  await nextTick()

  expect(sendMessageMock).toHaveBeenCalledTimes(1)
  // The passthrough does not validate fields — it forwards as-is
  expect(sendMessageMock).toHaveBeenCalledWith(
    'unclear request',
    { agent: 'some-agent' },
  )
  })

  it('should add user message to chatStore with correct content when subagent is present', async () => {
  const wrapper = mountPanel({ sessionId: 'session-msg' })

  const panel = wrapper.findComponent({ name: 'ChatPanel' })
  await panel.vm.$emit('send', {
    content: 'analyze this',
    subagent: { agent: 'analyst', task: 'Analyze performance' },
  })
  await nextTick()

  expect(addedMessages).toHaveLength(1)
  const msg = addedMessages[0] as { role: string; content: string }
  expect(msg.role).toBe('user')
  expect(msg.content).toBe('analyze this')
  })

  it('should add user message without skillName when subagent is present but no skillName', async () => {
  const wrapper = mountPanel({ sessionId: 'session-no-skill' })

  const panel = wrapper.findComponent({ name: 'ChatPanel' })
  await panel.vm.$emit('send', {
    content: 'agent task only',
    subagent: { agent: 'worker', task: 'Do work' },
  })
  await nextTick()

  const msg = addedMessages[0] as Record<string, unknown>
  expect(msg).not.toHaveProperty('skillName')
  })

  it('should not call sendMessage when sessionId is empty', async () => {
  const wrapper = mountPanel({ sessionId: '' })

  const panel = wrapper.findComponent({ name: 'ChatPanel' })
  await panel.vm.$emit('send', {
    content: 'should be ignored',
    subagent: { agent: 'agent', task: 'task' },
  })
  await nextTick()

  expect(sendMessageMock, 'sendMessage should not be called for empty sessionId').not.toHaveBeenCalled()
  })
})
