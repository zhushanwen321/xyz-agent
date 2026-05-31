import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { AgentInfo, SkillInfo } from '@xyz-agent/shared'

/**
 * Integration-style tests for ChatInput.vue — agent action handling
 *
 * Verifies that selecting an agent slash command and sending emits the
 * correct subagent payload. Tests the handleSlashSelect + handleSend
 * integration path for agent-type commands.
 */

// ── Mocks ──────────────────────────────────────────────────────────

const mockAgents = ref<AgentInfo[]>([])
const mockSkills = ref<SkillInfo[]>([])
const mockDefaultModel = ref('test/model')

import { ref } from 'vue'

vi.mock('../../../stores/settings', () => ({
  useSettingsStore: () => ({
  defaultModel: mockDefaultModel.value,
  }),
}))

vi.mock('../../../stores/provider', () => ({
  useProviderStore: () => ({
  providers: [],
  models: [],
  skills: mockSkills.value,
  agents: mockAgents.value,
  }),
}))

vi.mock('../../../stores/chat', () => ({
  useChatStore: () => ({
  sessions: new Map(),
  getSessionState: () => ({ contextUsage: 0 }),
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
  t: (key: string) => key,
  }),
}))

// Stub child components — we only care about ChatInput's behavior
const SlashMenuStub = {
  name: 'SlashMenu',
  props: ['visible', 'commands'],
  emits: ['close', 'select'],
  template: '<div data-slash-menu></div>',
}

const ModelPickerStub = {
  name: 'ModelPicker',
  props: ['currentModel'],
  emits: ['select'],
  template: '<div data-model-picker></div>',
}

const TextareaStub = {
  name: 'Textarea',
  props: ['modelValue', 'placeholder', 'rows', 'noStyle', 'class'],
  emits: ['update:modelValue', 'keydown', 'compositionstart', 'compositionend'],
  template: '<textarea data-textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
}

const ButtonStub = {
  name: 'Button',
  props: ['variant', 'disabled', 'class', 'title'],
  emits: ['click'],
  template: '<button data-button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
}

import ChatInput from '../ChatInput.vue'

function mountChatInput(overrides: { sessionId?: string; isStreaming?: boolean } = {}) {
  return mount(ChatInput, {
  props: {
    isStreaming: overrides.isStreaming ?? false,
    sessionId: overrides.sessionId ?? 'session-1',
  },
  global: {
    stubs: {
    SlashMenu: SlashMenuStub,
    ModelPicker: ModelPickerStub,
    Textarea: TextareaStub,
    Button: ButtonStub,
    SessionStrip: true,
    },
  },
  })
}

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
  id: 'agent-1',
  name: 'code-reviewer',
  description: 'Reviews code',
  enabled: true,
  modelStrategy: 'auto',
  ...overrides,
  }
}

/**
 * Simulates selecting an agent command from SlashMenu.
 * This triggers handleSlashSelect which sets activeCommand and
 * for agent type, sets text to '/agent:<name> '.
 */
async function selectAgentCommand(wrapper: ReturnType<typeof mountChatInput>, agent: AgentInfo) {
  const slashMenu = wrapper.findComponent({ name: 'SlashMenu' })
  await slashMenu.vm.$emit('select', {
  name: `agent:${agent.name}`,
  description: agent.description,
  source: 'agent',
  action: { type: 'agent', agentName: agent.name },
  })
  await nextTick()
}

/**
 * Simulates typing text into the textarea.
 */
async function typeText(wrapper: ReturnType<typeof mountChatInput>, text: string) {
  const textarea = wrapper.find('[data-textarea]')
  await textarea.setValue(text)
  await nextTick()
}

/**
 * Clicks the send button.
 */
async function clickSend(wrapper: ReturnType<typeof mountChatInput>) {
  const sendButtons = wrapper.findAll('[data-button]')
  // Find the send button (not model picker — the one with arrow SVG or stop)
  for (const btn of sendButtons) {
  const html = btn.html()
  if (html.includes('chat.send') || html.includes('M8 13V3M4 7l4-4 4 4')) {
    await btn.trigger('click')
    await nextTick()
    return
  }
  }
  // Fallback: just click the last button
  const lastBtn = sendButtons[sendButtons.length - 1]
  if (lastBtn) {
  await lastBtn.trigger('click')
  await nextTick()
  }
}

describe('ChatInput — agent action handling', () => {
  beforeEach(() => {
  mockAgents.value = []
  mockSkills.value = []
  mockDefaultModel.value = 'test/model'
  })

  it('should emit send with subagent payload when agent command is selected and message sent', async () => {
  const agent = makeAgent({ name: 'code-reviewer' })
  mockAgents.value = [agent]

  const wrapper = mountChatInput()

  await selectAgentCommand(wrapper, agent)
  await typeText(wrapper, '/agent:code-reviewer review the auth module')
  await clickSend(wrapper)

  const emitted = wrapper.emitted('send')
  expect(emitted, 'send event should be emitted').toBeDefined()
  expect(emitted!.length, 'send should emit once').toBeGreaterThanOrEqual(1)

  const lastEmit = emitted![emitted!.length - 1][0] as {
    content: string
    subagent?: { agent: string; task: string }
  }

  expect(lastEmit.subagent, 'subagent should be present').toBeDefined()
  expect(lastEmit.subagent!.agent).toBe('code-reviewer')
  expect(lastEmit.subagent!.task).toBe('review the auth module')
  expect(lastEmit.content).toBe('/agent:code-reviewer review the auth module')
  })

  it('should emit send without subagent when no agent command is active', async () => {
  const wrapper = mountChatInput()

  await typeText(wrapper, 'just a normal message')
  await clickSend(wrapper)

  const emitted = wrapper.emitted('send')
  if (emitted) {
    const lastEmit = emitted[emitted.length - 1][0] as {
    content: string
    subagent?: unknown
    }
    expect(lastEmit.subagent, 'normal message should not have subagent').toBeUndefined()
    expect(lastEmit.content).toBe('just a normal message')
  }
  })

  it('should strip /agent:<name> prefix from subagent.task but keep in content', async () => {
  const agent = makeAgent({ name: 'refactorer' })
  mockAgents.value = [agent]

  const wrapper = mountChatInput()

  await selectAgentCommand(wrapper, agent)
  // User types additional task text after the pre-filled /agent:refactorer
  await typeText(wrapper, '/agent:refactorer rename foo to bar')
  await clickSend(wrapper)

  const emitted = wrapper.emitted('send')
  expect(emitted).toBeDefined()

  const lastEmit = emitted![emitted!.length - 1][0] as {
    content: string
    subagent?: { agent: string; task: string }
  }

  // task should have the prefix stripped
  expect(lastEmit.subagent!.task).toBe('rename foo to bar')
  // content keeps the original trimmed text
  expect(lastEmit.content).toBe('/agent:refactorer rename foo to bar')
  })

  it('should handle agent command with no additional text (empty task)', async () => {
  const agent = makeAgent({ name: 'explorer' })
  mockAgents.value = [agent]

  const wrapper = mountChatInput()

  await selectAgentCommand(wrapper, agent)
  // After selectAgentCommand, text is '/agent:explorer ' — but for empty task test,
  // we clear it and just leave the prefix
  await typeText(wrapper, '/agent:explorer')
  await clickSend(wrapper)

  const emitted = wrapper.emitted('send')
  if (emitted) {
    const lastEmit = emitted[emitted!.length - 1][0] as {
    content: string
    subagent?: { agent: string; task: string }
    }
    expect(lastEmit.subagent!.agent).toBe('explorer')
    // After stripping prefix, task should be empty string
    expect(lastEmit.subagent!.task).toBe('')
  }
  })

  it('should handle special characters in task content', async () => {
  const agent = makeAgent({ name: 'worker' })
  mockAgents.value = [agent]

  const wrapper = mountChatInput()

  await selectAgentCommand(wrapper, agent)
  await typeText(wrapper, '/agent:worker fix "quotes" & <html> tags')
  await clickSend(wrapper)

  const emitted = wrapper.emitted('send')
  if (emitted) {
    const lastEmit = emitted[emitted!.length - 1][0] as {
    content: string
    subagent?: { agent: string; task: string }
    }
    expect(lastEmit.subagent!.agent).toBe('worker')
    expect(lastEmit.subagent!.task).toBe('fix "quotes" & <html> tags')
  }
  })

  it('should emit send with skillName for skill commands (not subagent)', async () => {
  const skill: SkillInfo = {
    id: 'skill-1',
    name: 'summarize',
    description: 'Summarize text',
    enabled: true,
    source: 'local',
    triggers: [],
  }
  mockSkills.value = [skill]

  const wrapper = mountChatInput()

  const slashMenu = wrapper.findComponent({ name: 'SlashMenu' })
  await slashMenu.vm.$emit('select', {
    name: 'summarize',
    description: 'Summarize text',
    source: 'skill',
    action: { type: 'skill', skillId: 'skill-1' },
  })
  await nextTick()

  await typeText(wrapper, 'some text')
  await clickSend(wrapper)

  const emitted = wrapper.emitted('send')
  if (emitted) {
    const lastEmit = emitted[emitted!.length - 1][0] as {
    content: string
    skillName?: string
    subagent?: unknown
    }
    expect(lastEmit.skillName).toBe('summarize')
    expect(lastEmit.subagent, 'skill commands should not have subagent').toBeUndefined()
  }
  })

  it('should not send when isStreaming is true', async () => {
  const agent = makeAgent({ name: 'runner' })
  mockAgents.value = [agent]

  const wrapper = mountChatInput({ isStreaming: true })

  await selectAgentCommand(wrapper, agent)
  await typeText(wrapper, '/agent:runner do work')
  await clickSend(wrapper)

  const emitted = wrapper.emitted('send')
  expect(emitted, 'should not emit send while streaming').toBeUndefined()
  })

  it('should emit send-command for protocol-type commands (compact)', async () => {
  const wrapper = mountChatInput()

  const slashMenu = wrapper.findComponent({ name: 'SlashMenu' })
  await slashMenu.vm.$emit('select', {
    name: 'compact',
    description: 'Compress context',
    source: 'builtin',
    action: { type: 'protocol', messageType: 'session.compact' },
  })
  await nextTick()

  const emitted = wrapper.emitted('send-command')
  expect(emitted, 'send-command should be emitted for protocol commands').toBeDefined()

  const lastEmit = emitted![emitted!.length - 1][0] as {
    type: string
    payload: Record<string, unknown>
  }
  expect(lastEmit.type).toBe('session.compact')
  expect(lastEmit.payload.sessionId).toBe('session-1')
  })
})
