/**
 * Turn pending 气泡单测 —— steer/followup 入队后的 pending 渲染（draft-composer-states S7）。
 *
 * 三视角覆盖：
 * - 观察者（形态）：pending steer 蓝虚线 + STEER 追加标签；pending followUp 青虚线 + FOLLOWUP 新轮
 * - 使用者（黑盒）：pending 气泡不显示 hover actions（复制/编辑）；complete 态恢复正常气泡
 * - 构建者（白盒）：status='complete' 走普通气泡分支，status='pending' 走虚线分支
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/turn-pending-bubble.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import Turn from '@/components/panel/message-stream/Turn.vue'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@xyz-agent/shared'

vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn() }),
}))
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn() }),
}))

function makeTurn(userOver: Partial<Message> = {}): MessageTurn {
  return {
    index: 1,
    user: {
      id: 'u1',
      role: 'user',
      content: '补充注册页校验',
      status: 'complete',
      timestamp: Date.now(),
      ...userOver,
    },
    assistants: [],
    isWorking: false,
    hasFoldable: false,
  }
}

function mountTurn(turn: MessageTurn) {
  return mount(Turn, {
    props: { turn, sessionId: 's1' },
    global: {
      plugins: [createPinia()],
      stubs: { Block: true, ChangeSetCard: true, ForkConfirmModal: true, MarkdownRenderer: true },
    },
  })
}

describe('Turn pending 气泡（S7）', () => {
  it('pending steer → 渲染虚线边框 + STEER 追加标签 + accent 蓝', () => {
    const wrapper = mountTurn(makeTurn({ status: 'pending', sendMode: 'steer' }))
    expect(wrapper.text()).toContain('STEER 追加')
    expect(wrapper.text()).toContain('补充注册页校验')
    // 虚线边框（border-dashed + accent 边框色）
    const bubble = wrapper.find('.border-dashed')
    expect(bubble.exists()).toBe(true)
    expect(bubble.classes().some((c) => c.includes('accent') || c.includes('79,142,247'))).toBe(true)
  })

  it('pending follow-up → 渲染 FOLLOWUP 新轮 标签 + info 青', () => {
    const wrapper = mountTurn(makeTurn({
      status: 'pending',
      sendMode: 'follow-up',
      content: '下轮任务',
    }))
    expect(wrapper.text()).toContain('FOLLOWUP 新轮')
    expect(wrapper.text()).toContain('下轮任务')
    const bubble = wrapper.find('.border-dashed')
    expect(bubble.exists()).toBe(true)
    expect(bubble.classes().some((c) => c.includes('info') || c.includes('56,189,248'))).toBe(true)
  })

  it('complete user → 走普通气泡（无虚线、无 STEER/FOLLOWUP 标签）', () => {
    const wrapper = mountTurn(makeTurn({ status: 'complete' }))
    expect(wrapper.find('.border-dashed').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('STEER 追加')
    expect(wrapper.text()).not.toContain('FOLLOWUP 新轮')
  })

  it('pending 气泡不显示 hover actions（无复制/编辑按钮）', () => {
    const wrapper = mountTurn(makeTurn({ status: 'pending', sendMode: 'steer' }))
    // pending 态 hover actions 整块不渲染（v-if="!isEditingThisUser && !isPendingUser"）
    // 复制按钮 title="复制" 不存在
    const copyBtn = wrapper.find('button[title="复制"]')
    expect(copyBtn.exists()).toBe(false)
  })

  it('complete user 显示 hover actions（复制按钮存在，hover 可见）', () => {
    const wrapper = mountTurn(makeTurn({ status: 'complete' }))
    expect(wrapper.find('button[title="复制"]').exists()).toBe(true)
  })
})
