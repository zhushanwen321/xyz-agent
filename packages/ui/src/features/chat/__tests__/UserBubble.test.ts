/**
 * UserBubble.vue 组件测试（W4TC3）。
 *
 * 覆盖：
 * - W4TC3: UserBubble 拆分后渲染一致（展示态/编辑态 + badge + hover actions）
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

  // ── U2b：session / subagent 段徽标（四符号 # / @）──

  it('Segment[] content 含 session segment → 渲染 # label 徽标（warn 色，title 悬浮 sessionId）', () => {
    const segments: Segment[] = [
      { type: 'text', text: '参考 ' },
      { type: 'session', sessionId: '019e-abc', label: '设计讨论' } as Segment,
    ]
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
      }),
    })
    const badge = wrapper.find('[data-testid="msg-session-badge-1"]')
    expect(badge.exists()).toBe(true)
    // 徽标显示 # + label（人可读标题，非 uuid）
    expect(badge.text()).toContain('#')
    expect(badge.text()).toContain('设计讨论')
    expect(badge.classes()).toContain('text-warn')
    expect(badge.attributes('title')).toBe('019e-abc')
  })

  it('Segment[] content 含 subagent segment → 渲染 @slug 去向徽标（accent 色，序列化空串仅作标记）', () => {
    const segments: Segment[] = [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' } as Segment,
      { type: 'text', text: '汇报进度' },
    ]
    const wrapper = mountBubble({
      turn: makeTurn({
        user: { id: 'u1', role: 'user', content: segments, status: 'complete', timestamp: NOW } as Message,
      }),
    })
    const badge = wrapper.find('[data-testid="msg-subagent-badge-0"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('@build-api')
    expect(badge.classes()).toContain('text-accent')
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
    // emit edit-state-change（D2：负载携带 turnKey = turnStableId(turn) = 'u1'）
    expect(wrapper.emitted('edit-state-change')).toBeTruthy()
    expect(wrapper.emitted('edit-state-change')![0]).toEqual([{ editing: true, turnKey: 'u1' }])
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
    // 最后一次 emit 是 false（D2：负载携带 turnKey）
    const events = wrapper.emitted('edit-state-change')!
    expect(events[events.length - 1]).toEqual([{ editing: false, turnKey: 'u1' }])
  })

  // D3 卸载清理（C2 检查点）：编辑态中组件卸载时必须补发解除信号——切 session 等
  // 路径卸载本组件时 watch 随作用域失效、显式清理动作不会执行，父组件钉扎状态
  // 只能靠这条 emit 复位。C2 实测：onUnmounted 内 emit 父监听器可达。
  it('编辑态中卸载 → 父组件收到 { editing: false, turnKey }（D3 卸载清理）', async () => {
    const wrapper = mountBubble({ canEdit: true, isSessionEditable: false })
    const actions = wrapper.find('.group\\/user .opacity-0')
    const buttons = actions.findAll('button')
    await buttons[1].trigger('click')
    expect(wrapper.emitted('edit-state-change')!.length).toBe(1)
    // 不退出编辑直接卸载（模拟切 session 时 UserBubble 被连根卸载）
    wrapper.unmount()
    // test-utils 的 wrapper.unmount() 会先 removeEventHistory 清掉卸载前的 emit 记录，
    // 故数组里只剩卸载流程中钩子补发的那一条——恰好证明它来自卸载清理而非先前操作
    expect(wrapper.emitted('edit-state-change')).toEqual([[{ editing: false, turnKey: 'u1' }]])
  })
})
