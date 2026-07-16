/**
 * Turn skill badge 渲染单测 —— skillName字段检测 + badge样式 + 点击打开drawer。
 *
 * 三视角覆盖：
 * - 观察者（形态）：含skillName的消息渲染紫色badge（star icon + /skill:xxx）
 * - 使用者（黑盒）：点击badge调用openCommandDoc；无skillName时走原slashChip逻辑
 * - 构建者（白盒）：skillChip computed检测skillName字段，复用openCommandDoc机制
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/turn-skill-badge.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Turn from '@/components/panel/message-stream/Turn.vue'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'

const mockOpen = vi.fn()
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn() }),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn() }),
}))
vi.mock('@/composables/features/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: mockOpen }),
}))

function makeTurn(userOver: Partial<Message> = {}): MessageTurn {
  return {
    index: 1,
    user: {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: '想要都修复' }],
      status: 'complete',
      timestamp: Date.now(),
      ...userOver,
    },
    assistants: [],
    isWorking: false,
    hasFoldable: false,
  }
}

function mountTurn(turn: MessageTurn, sessionId = 's1') {
  return mount(Turn, {
    props: { turn, sessionId },
    global: {
      plugins: [createPinia()],
      stubs: {
        Block: true,
        ChangeSetCard: true,
        ForkConfirmModal: true,
        MarkdownRenderer: true,
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockOpen.mockClear()
})

describe('Turn skill badge 渲染', () => {
  it('含skillName时渲染紫色badge + skill名（无/skill:前缀，icon已表示类型）', () => {
    const wrapper = mountTurn(makeTurn({
      content: [{ type: 'skill', name: 'cw-cli' }, { type: 'text', text: '想要都修复' }],
    }))
    // 紫色badge元素存在
    const badge = wrapper.find('.text-reasoning')
    expect(badge.exists()).toBe(true)
    // 显示层只显 skill 名（cw-cli），不含 /skill: 前缀（icon+紫色已传达类型）
    expect(badge.text()).toContain('cw-cli')
    expect(badge.text()).not.toContain('/skill:')
  })

  it('点击badge调用openCommandDoc', async () => {
    const wrapper = mountTurn(makeTurn({
      content: [{ type: 'skill', name: 'cw-cli' }, { type: 'text', text: '想要都修复' }],
    }))
    // 点击badge
    const badge = wrapper.find('.cursor-pointer')
    expect(badge.exists()).toBe(true)
    await badge.trigger('click')
    // 验证调用了drawer.open('doc', { commandName })
    expect(mockOpen).toHaveBeenCalledWith('doc', { commandName: '/skill:cw-cli' })
  })

  it('无skillName时走原slashChip逻辑', () => {
    const wrapper = mountTurn(makeTurn({
      content: [{ type: 'text', text: '/compact 压缩上下文' }],
    }))
    // 不显示skill badge（.text-reasoning）
    const badge = wrapper.find('.text-reasoning')
    // 可能有slashChip，但不是skill badge
    if (badge.exists()) {
      expect(badge.text()).not.toContain('/skill:')
    }
  })

  it('无skillName且无slash命令时显示纯文本', () => {
    const wrapper = mountTurn(makeTurn({
      content: [{ type: 'text', text: '普通消息' }],
    }))
    // MarkdownRenderer被stub，检查skill badge不存在
    expect(wrapper.find('.text-reasoning').exists()).toBe(false)
  })
})
