/**
 * Session active state 统一回归测试（E1-E4）。
 *
 * 锁定 cw-2026-07-09-unify-session-active-state 的核心修复：isActive 作为 UI 层执行态 SSOT，
 * 消除「提交后到 pi message_start 之间」空窗期的状态不一致；compact 互斥态独立驱动 running。
 *
 * 三视角覆盖（AGENTS.md 测试规范 #5-8）：
 * - 构建者（白盒）：store.addPendingSend / setCompacting → isActive / isCompacting → deriveStatus
 * - 使用者（黑盒）：mount SessionItem/Panel 断言 DOM（圆点动画 / Composer 渲染 / Landing 守卫）
 * - 观察者（形态）：dot class 含 pulse 动画类、composer/landing testid 存在
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-active-state.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import Panel from '@/components/panel/Panel.vue'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useSessionDerivations } from '@/composables/features/useSessionDerivations'
import { DOT_CLASS } from '@/composables/logic/sessionStatus'
import type { SessionSummary } from '@xyz-agent/shared'

/** Panel 子组件 stub（隔离 PanelHeader/MessageStream 等的重渲染，聚焦被测逻辑） */
const panelStubs = {
  PanelHeader: { template: '<div />' },
  ProgressZone: { template: '<div />' },
  MessageStream: { template: '<div data-testid="msg-stream" />' },
  Composer: { template: '<div data-testid="composer" />' },
  Landing: { template: '<div data-testid="landing">landing</div>' },
}

function makeSession(id: string): SessionSummary {
  return {
    id,
    label: id,
    cwd: '/repo',
    status: 'idle',
    lastActiveAt: Date.now(),
    modelId: 'test-model',
    tokenCount: 0,
  }
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
    global: { stubs: panelStubs },
  })
}

beforeEach(() => setActivePinia(createPinia()))

describe('E1: 提交后空窗期圆点 running（核心 bug 回归）', () => {
  it('addPendingSend 后 isActive=true → derivedStatus=running，dot 含 pulse 动画', () => {
    const chat = useChatStore()
    const sessionStore = useSessionStore()
    const { derivedStatus } = useSessionDerivations()

    const session = makeSession('s1')
    sessionStore.appendSession(session)

    // 用户提交瞬间：pendingSend 填空窗（pi 尚未 message_start）
    chat.addPendingSend('s1')
    expect(chat.isActive('s1')).toBe(true)

    // derivedStatus 响应式计算应为 running
    const status = derivedStatus('s1').value
    expect(status).toBe('running')

    // mount SessionItem 传 running status → dot class 含 pulse 动画（使用者可见）
    const wrapper = mount(SessionItem, {
      props: { session, active: true, status },
    })
    const dot = wrapper.find('span.size-2')
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('animate-pulse-accent')

    // 清理 pendingSend timer 避免 leak
    chat.clearPendingSend('s1')
  })
})

describe('E2: 非焦点 session 提交后圆点 running（activeId 限定已移除）', () => {
  it('activeId=A + addPendingSend(B) → derivedStatus(B)=running', () => {
    const chat = useChatStore()
    const sessionStore = useSessionStore()
    const { derivedStatus } = useSessionDerivations()

    const sessionA = makeSession('A')
    const sessionB = makeSession('B')
    sessionStore.appendSession(sessionA)
    sessionStore.appendSession(sessionB)

    // 模拟 split：A 是焦点 panel，B 是非焦点 panel
    sessionStore.activeId = 'A'
    expect(sessionStore.active?.id).toBe('A')

    // 用户在 B panel 提交（B 非焦点）→ pendingSend(B) 应驱动 B 的 running
    chat.addPendingSend('B')
    expect(chat.isActive('B')).toBe(true)

    // B 非焦点但 derivedStatus(B) 仍 running（activeId 限定已移除，bug 修复核心）
    const statusB = derivedStatus('B').value
    expect(statusB).toBe('running')

    // mount SessionItem(B) 传 running → dot pulse（非焦点 session 也正确显示执行态）
    const wrapper = mount(SessionItem, {
      props: { session: sessionB, active: false, status: statusB },
    })
    expect(wrapper.find('span.size-2').classes()).toContain('animate-pulse-accent')

    chat.clearPendingSend('B')
  })
})

describe('E3: compact 期圆点 running + Panel 渲染 Composer（isCompacting 分支）', () => {
  it('setCompacting(s1,true) → derivedStatus=running；Panel 渲染 Composer', () => {
    const chat = useChatStore()
    const sessionStore = useSessionStore()
    const { derivedStatus } = useSessionDerivations()

    const session = makeSession('s1')
    sessionStore.appendSession(session)

    // 触发 compact：compact 互斥态开启
    chat.setCompacting('s1', true)
    expect(chat.isCompacting('s1')).toBe(true)

    // compact 不并入 isActive（设计约束：用户不可干预压缩流程）
    expect(chat.isActive('s1')).toBe(false)

    // 但 derivedStatus 应为 running（compact 视觉态属 running，走 isCompacting 独立分支）
    const status = derivedStatus('s1').value
    expect(status).toBe('running')

    // mount Panel(s1) → Composer 在 DOM 中（showPanelComposer 含 isCompacting 分支）
    const wrapper = mountPanel('s1')
    expect(wrapper.find('[data-testid="composer"]').exists()).toBe(true)
  })
})

describe('E4: Panel landing 态不被其他 session 流式误伤（回归保护）', () => {
  it('Panel(sessionId=null) + session-A 流式 → 渲染 Landing，不落兜底空态', () => {
    const chat = useChatStore()

    // 模拟 A 会话正在流式（message_start 创建 streaming entity）
    chat.applyMessageEvent('session-A', {
      type: 'message.message_start',
      payload: { sessionId: 'session-A', messageId: 'a1' },
    })
    expect(chat.isGenerating('session-A')).toBe(true)

    // Panel 绑定 sessionId=null（landing 态，点新建后的空 panel）
    const wrapper = mountPanel(null)

    // 关键回归断言：A 流式不误伤 landing panel（per-session isGenerating 守卫）
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(true)
    // 不落兜底空态（「选择左侧会话开始」）
    expect(wrapper.text()).not.toContain('选择左侧会话开始')
  })
})

describe('DOT_CLASS SSOT 一致性（附加 sanity）', () => {
  it('running 态映射 animate-pulse-accent，与 SessionItem dot 渲染一致', () => {
    // 确认 DOT_CLASS SSOT 映射未被意外修改（sessionStatus.ts 的 5 态表是圆点渲染源头）
    expect(DOT_CLASS.running).toContain('animate-pulse-accent')
    expect(DOT_CLASS.done).toBe('bg-success')
  })
})
