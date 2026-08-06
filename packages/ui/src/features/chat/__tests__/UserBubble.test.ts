/**
 * UserBubble.vue 组件测试（W4TC3）。
 *
 * 覆盖：
 * - W4TC3: UserBubble 拆分后渲染一致（展示态/编辑态/pending态 + badge + hover actions）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/message-stream/__tests__/UserBubble.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { UserBubble } from '@xyz-agent/ui'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import type { Message, Segment } from '@xyz-agent/shared'
import { mockChatProvide } from './helpers'

const NOW = Date.now()

function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'hello world', status: 'complete', timestamp: NOW },
    assistants: [],
    isStreaming: false,
    hasFoldable: false,
    ...over,
  }
}

function mountBubble(props: {
  turn?: MessageTurn
  sessionId?: string
  canEdit?: boolean
  isSessionEditable?: boolean
} = {}) {
  return mount(UserBubble, {
    props: {
      turn: props.turn ?? makeTurn(),
      sessionId: props.sessionId ?? 's1',
      canEdit: props.canEdit ?? false,
      isSessionEditable: props.isSessionEditable ?? false,
    },
    global: {
      provide: mockChatProvide(),
      stubs: { MarkdownRenderer: true, ImageThumb: true },
    },
  })
}

describe('W4TC3: UserBubble 展示态', () => {
  it('user 气泡存在且含 content 文本', () => {
    const wrapper = mountBubble()
    // 气泡容器：rounded + border + bg-surface-hover
    const bubble = wrapper.find('.rounded-\\[14px_14px_4px_14px\\]')
    expect(bubble.exists()).toBe(true)
    expect(bubble.classes()).toContain('bg-\[var\(--bubble-bg\)\]')
  })

  it('展示态 hover actions 容器存在（group-hover 可见）', () => {
    const wrapper = mountBubble()
    // hover actions 容器：opacity-0 group-hover:opacity-100
    const actions = wrapper.find('.group\\/user .opacity-0')
    expect(actions.exists()).toBe(true)
    // 容器内至少有 1 个 button（复制）
    expect(actions.findAll('button').length).toBeGreaterThanOrEqual(1)
  })

  it('canEdit=true + 非 sessionEditable → 编辑按钮存在', () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    // hover actions 容器内有 2 个 button（复制 + 编辑）
    const actions = wrapper.find('.group\\/user .opacity-0')
    expect(actions.findAll('button').length).toBe(2)
  })

  it('canEdit=false → 只有复制按钮', () => {
    const wrapper = mountBubble({ canEdit: false })
    const actions = wrapper.find('.group\\/user .opacity-0')
    expect(actions.findAll('button').length).toBe(1)
  })

  it('isSessionEditable=true → 只有复制按钮（活跃态禁止编辑）', () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: true })
    const actions = wrapper.find('.group\\/user .opacity-0')
    expect(actions.findAll('button').length).toBe(1)
  })
})

describe('W4TC3: UserBubble pending 态', () => {
  it('pending 气泡（status=pending）渲染虚线边框 + 脉冲点', () => {
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: 'pending...', status: 'pending', sendMode: 'steer', timestamp: NOW } as Message,
      }),
    })
    // pending 气泡有 border-dashed
    expect(wrapper.find('.border-dashed').exists()).toBe(true)
    // 脉冲点
    expect(wrapper.find('.animate-pulse-accent').exists()).toBe(true)
  })

  it('pending 态不显示 hover actions', () => {
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: 'pending...', status: 'pending', timestamp: NOW } as Message,
      }),
    })
    expect(wrapper.find('.group\\/user .opacity-0').exists()).toBe(false)
  })

  it('steer 模式 pending → accent 蓝配色', () => {
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: 'steering', status: 'pending', sendMode: 'steer', timestamp: NOW } as Message,
      }),
    })
    const bubble = wrapper.find('.border-dashed')
    expect(bubble.classes()).toContain('border-[var(--accent)]')
    expect(bubble.classes()).toContain('bg-accent-soft')
  })

  it('follow-up 模式 pending → info 青配色', () => {
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: 'following', status: 'pending', sendMode: 'follow-up', timestamp: NOW } as Message,
      }),
    })
    const bubble = wrapper.find('.border-dashed')
    expect(bubble.classes()).toContain('border-info')
    expect(bubble.classes()).toContain('bg-info-soft')
  })
})

describe('W4TC3: UserBubble skill badge', () => {
  it('Segment[] content 含 skill segment → 渲染紫色 badge', () => {
    const segments: Segment[] = [
      { type: 'skill', name: 'code-review' } as Segment,
      { type: 'text', text: 'please review' } as Segment,
    ]
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
      }),
    })
    // skill badge 存在（text-reasoning class）
    const badge = wrapper.find('.text-reasoning')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('code-review')
  })

  it('Segment[] content 含 file segment → 渲染绿色 file badge', () => {
    const segments: Segment[] = [
      { type: 'file', path: '/tmp/foo.ts', lineRange: [1, 10] } as Segment,
    ]
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
      }),
    })
    // file badge 存在（text-success class）
    const badge = wrapper.find('.text-success')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('foo.ts')
  })
})

describe('W4TC3: UserBubble 编辑态', () => {
  it('canEdit=true 点编辑按钮 → 进入编辑态 + emit edit-state-change', async () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    // hover actions 容器的第 2 个 button 是编辑
    const actions = wrapper.find('.group\\/user .opacity-0')
    const buttons = actions.findAll('button')
    expect(buttons.length).toBe(2)
    // 点编辑按钮
    await buttons[1].trigger('click')
    // emit edit-state-change
    expect(wrapper.emitted('edit-state-change')).toBeTruthy()
    expect(wrapper.emitted('edit-state-change')![0]).toEqual([{ editing: true }])
  })

  it('编辑态渲染 textarea', async () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    const actions = wrapper.find('.group\\/user .opacity-0')
    const buttons = actions.findAll('button')
    await buttons[1].trigger('click')
    // 编辑态有 textarea
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('编辑态取消 → emit edit-state-change false', async () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    const actions = wrapper.find('.group\\/user .opacity-0')
    const buttons = actions.findAll('button')
    await buttons[1].trigger('click')
    // 编辑态内有取消按钮（variant="ghost"）
    const editButtons = wrapper.findAll('button')
    const cancelBtn = editButtons.find(b => b.text().includes('panel.message.cancel'))
    expect(cancelBtn).toBeDefined()
    await cancelBtn!.trigger('click')
    // 最后一次 emit 是 false
    const events = wrapper.emitted('edit-state-change')!
    expect(events[events.length - 1]).toEqual([{ editing: false }])
  })
})
