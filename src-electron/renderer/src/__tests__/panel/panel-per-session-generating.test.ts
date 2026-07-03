/**
 * Panel per-session 生成态守卫回归测试。
 *
 * 锁定 bug：Panel.vue 的 isGenerating 原用全局 chat.isStreaming，导致跨 session 误伤——
 * A 会话流式期间点「新建任务」切到空 session（sessionId=null），空 session 的 Landing
 * 被 !isGenerating 守卫挡住，落到分支兜底空态（「选择左侧会话开始」），new-task 渲染撕裂。
 *
 * 修复：isGenerating 改为 per-session（chat.streamingSessionId === props.sessionId）。
 * 本测试 mount 真实 Panel.vue，覆盖两个关键场景的 DOM 渲染（使用者视角，非纯 store 断言）。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/panel/panel-per-session-generating.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue'
import { useChatStore } from '@/stores/chat'

const stubs = {
  PanelHeader: { template: '<div />' },
  ProgressZone: { template: '<div />' },
  MessageStream: { template: '<div data-testid="msg-stream" />' },
  Composer: { template: '<div data-testid="composer" />' },
  Landing: { template: '<div data-testid="landing">landing</div>' },
}

function mountPanel(sessionId: string | null) {
  return mount(Panel, {
    props: {
      panelId: 'panel-root',
      sessionId,
      sessionLabel: sessionId ?? '',
      sessionDir: '/repo',
      status: 'done' as never,
      active: true,
      isDual: false,
      isFirstPanel: true,
    },
    global: { stubs },
  })
}

beforeEach(() => setActivePinia(createPinia()))

describe('Panel per-session 生成态守卫（isGenerating 不跨 session 误伤）', () => {
  it('另一 session 流式中（sessionId=null）→ 渲染 Landing，不落兜底空态', () => {
    const chat = useChatStore()
    // 模拟 A 会话正在流式（message_start 记录 streamingSessionId）
    chat.applyMessageEvent('session-A', {
      type: 'message.message_start',
      payload: { sessionId: 'session-A', messageId: 'a1' },
    })
    expect(chat.isStreaming).toBe(true)
    expect(chat.streamingSessionId).toBe('session-A')

    // 点新建后切到空 session（sessionId=null）→ 应渲染 Landing
    const wrapper = mountPanel(null)
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(true)
    // 关键：不落兜底空态（「选择左侧会话开始」）
    expect(wrapper.text()).not.toContain('选择左侧会话开始')
  })

  it('本 Panel 的 session 在流式（messageCount=0）→ 不渲染 Landing（AC-2.8）', () => {
    const chat = useChatStore()
    // 本 Panel 绑定的 session-B 正在流式
    chat.applyMessageEvent('session-B', {
      type: 'message.message_start',
      payload: { sessionId: 'session-B', messageId: 'b1' },
    })

    const wrapper = mountPanel('session-B')
    // 本 session 在生成 → Landing 被抑制（AC-2.8：生成态优先，等 assistant 出现）
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
  })

  it('终态事件清空 streamingSessionId → isStreaming 恢复 false', () => {
    const chat = useChatStore()
    chat.applyMessageEvent('session-C', {
      type: 'message.message_start',
      payload: { sessionId: 'session-C', messageId: 'c1' },
    })
    expect(chat.streamingSessionId).toBe('session-C')

    chat.applyMessageEvent('session-C', {
      type: 'message.complete',
      payload: { sessionId: 'session-C' },
    })
    expect(chat.isStreaming).toBe(false)
    expect(chat.streamingSessionId).toBeNull()
  })
})
