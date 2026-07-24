/**
 * useSideDrawer per-session 控制态隔离单测（W3: U1-U9）。
 *
 * 验证从模块级单例 isOpen/activeTab/docked 重构为 per-session Map 分区后：
 * - U1 (AC-1): 跨 session 不干扰——后台 session 事件不弹当前 drawer
 * - U2 (AC-2): 切回恢复三态（isOpen/activeTab/docked）
 * - U3 (AC-3): pendingOpen 切回消费（自动开 tasks）
 * - U4 (AC-4): tasks docked 不污染其他 session
 * - U5 (AC-5): deleteSession 清理分区 + pendingOpen
 * - U6 (AC-6): 手动关后切回不被重开（无新事件）
 * - U7 (AC-7): 快速来回切幂等（pendingOpen 消费后不重复触发）
 * - U8 (AC-8): 手动 open 清 pendingOpen
 * - U9 (AC-9): 双 panel standby 无独立 drawer 状态
 *
 * 运行：npx vitest run src/__tests__/composables/useSideDrawer.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'

// ── mock panel store：控制 focusedSessionId（active panel 的 sessionId）──
// useSideDrawer 内部读 panel store 的 focusedSessionId computed 作分区键。
// 测试通过 setFocusedSessionId 切换「当前 active panel 绑定的 session」。
const mockFocusedSessionId = ref<string | null>(null)
const mockPanels = ref<Array<{ id: string; sessionId: string | null }>>([
  { id: 'panel-root', sessionId: null },
])

vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    get focusedSessionId() {
      return mockFocusedSessionId.value
    },
    get panels() {
      return mockPanels.value
    },
    setActive(panelId: string) {
      const p = mockPanels.value.find((leaf) => leaf.id === panelId)
      if (p) mockFocusedSessionId.value = p.sessionId
    },
    loadSession(panelId: string, sessionId: string | null) {
      const p = mockPanels.value.find((leaf) => leaf.id === panelId)
      if (p) {
        p.sessionId = sessionId
        if (panelId === 'panel-root') mockFocusedSessionId.value = sessionId
      }
    },
  }),
}))

import {
  useSideDrawer,
  resetSideDrawer,
  setPendingOpenForSid,
  consumePendingOpen,
  getPendingOpenForSid,
} from '@/composables/features/useSideDrawer'
import { triggerSessionCleanups } from '@/composables/useSessionScopedState'

/** 切换当前 focused session（模拟 selectSession 改 active panel 的 session 绑定） */
function focusSession(sid: string | null): void {
  mockFocusedSessionId.value = sid
}

beforeEach(() => {
  // 注意：不调 __clearSessionCleanupRegistryForTest()——useSideDrawer 是模块级单例，
  // controlState + pendingOpen 的 cleanup 注册在模块加载时完成（一次），跨 test 保留是正确的。
  // clear 反而会丢掉单例的 cleanup 注册，导致 U5 的 triggerSessionCleanups 验证失效。
  // 状态隔离靠 resetSideDrawer（清分区 + pendingOpen）。
  mockFocusedSessionId.value = null
  mockPanels.value = [{ id: 'panel-root', sessionId: null }]
  resetSideDrawer()
})

describe('useSideDrawer U1 (AC-1) 跨 session 不干扰', () => {
  it('session A 有 pending tasks 事件，用户在 B，B 的 drawer 不被弹开', () => {
    focusSession('B')
    const { isOpen, activeTab } = useSideDrawer()

    // 后台 session A 的 tasks 事件到达（A !== focused B）→ 只置 pendingOpen，不直接 open
    setPendingOpenForSid('A')

    // B 的 drawer 不被弹开
    expect(isOpen.value).toBe(false)
    expect(activeTab.value).toBe('terminal')
    // A 的 pendingOpen 已记录
    expect(getPendingOpenForSid('A')).toBe(true)
  })
})

describe('useSideDrawer U2 (AC-2) 切回恢复三态', () => {
  it('A 的 drawer 开/tasks/docked，切 B 再切回 A 全恢复', () => {
    focusSession('A')
    const drawer = useSideDrawer()
    drawer.open('tasks') // tasks tab 强制 docked=true（仅 A 分区）

    // 切到 B（B 独立操作，不影响 A 分区）
    focusSession('B')
    const drawerB = useSideDrawer()
    expect(drawerB.isOpen.value).toBe(false)
    expect(drawerB.activeTab.value).toBe('terminal')

    // 切回 A
    focusSession('A')
    const drawerA = useSideDrawer()
    expect(drawerA.isOpen.value).toBe(true)
    expect(drawerA.activeTab.value).toBe('tasks')
    expect(drawerA.docked.value).toBe(true)
  })
})

describe('useSideDrawer U3 (AC-3) pendingOpen 切回消费', () => {
  it('后台 C 事件置 pendingOpen[C]，selectSession(C) 消费后自动开 tasks 并清标记', () => {
    focusSession('A')
    setPendingOpenForSid('C')

    // 用户切到 C（selectSession 内部会调 consumePendingOpen）
    focusSession('C')
    consumePendingOpen('C')
    const drawer = useSideDrawer()

    expect(drawer.isOpen.value).toBe(true)
    expect(drawer.activeTab.value).toBe('tasks')
    expect(getPendingOpenForSid('C')).toBe(false)
  })
})

describe('useSideDrawer U4 (AC-4) tasks docked 不污染其他 session', () => {
  it('A 的 tasks tab docked=true，切到 B，B 的 docked 是自己记忆(false)', () => {
    focusSession('A')
    useSideDrawer().open('tasks') // tasks 强制 docked=true（仅 A 分区）

    focusSession('B')
    const drawerB = useSideDrawer()
    expect(drawerB.docked.value).toBe(false) // B 默认，不被 A 污染

    // 切回 A，A 的 docked 仍 true
    focusSession('A')
    expect(useSideDrawer().docked.value).toBe(true)
  })
})

describe('useSideDrawer U5 (AC-5) deleteSession 清理分区', () => {
  it('triggerSessionCleanups(A) 清掉 A 控制态分区 + pendingOpen[A]', () => {
    focusSession('A')
    useSideDrawer().open('tasks')
    setPendingOpenForSid('A')
    expect(getPendingOpenForSid('A')).toBe(true)

    // session 销毁编排
    triggerSessionCleanups('A')

    // pendingOpen[A] 已清
    expect(getPendingOpenForSid('A')).toBe(false)
    // A 分区重置：切到 A 应是默认态（isOpen=false）
    focusSession('A')
    expect(useSideDrawer().isOpen.value).toBe(false)
    expect(useSideDrawer().activeTab.value).toBe('terminal')
  })
})

describe('useSideDrawer U6 (AC-6) 手动关不被重开', () => {
  it('A 手动 open 后 close，切走再切回，drawer 保持关闭（无新事件）', () => {
    focusSession('A')
    const drawer = useSideDrawer()
    drawer.open('git')
    drawer.close()

    focusSession('B')
    focusSession('A') // 切回，无 pendingOpen（无新事件）
    consumePendingOpen('A') // selectSession 会调，但 pendingOpen[A]=false

    expect(useSideDrawer().isOpen.value).toBe(false)
  })
})

describe('useSideDrawer U7 (AC-7) 快速来回切幂等', () => {
  it('A pendingOpen=true，A→B→A 第二次到 A 不重复 open', () => {
    setPendingOpenForSid('A')

    // 第一次切到 A：消费 pendingOpen
    focusSession('A')
    consumePendingOpen('A')
    expect(useSideDrawer().isOpen.value).toBe(true)
    expect(getPendingOpenForSid('A')).toBe(false)

    // 关掉 A 的 drawer，模拟用户看完后关
    useSideDrawer().close()

    // 切 B 再切回 A：pendingOpen 已清，不应重开
    focusSession('B')
    focusSession('A')
    consumePendingOpen('A')

    expect(useSideDrawer().isOpen.value).toBe(false)
    expect(getPendingOpenForSid('A')).toBe(false)
  })
})

describe('useSideDrawer U8 (AC-8) 手动 open 清 pendingOpen', () => {
  it('A 有 pendingOpen=true，手动 open("git") 后清标记', () => {
    focusSession('A')
    setPendingOpenForSid('A')
    expect(getPendingOpenForSid('A')).toBe(true)

    useSideDrawer().open('git') // 手动 open（任意 tab）

    expect(getPendingOpenForSid('A')).toBe(false)
  })
})

describe('useSideDrawer U9 (AC-9) 双 panel standby 无独立状态', () => {
  it('setActive(P2) 后 drawer 显示 B 分区状态（standby 期间无独立维护）', () => {
    // 双 panel 布局：P1(A) P2(B)
    mockPanels.value = [
      { id: 'P1', sessionId: 'A' },
      { id: 'P2', sessionId: 'B' },
    ]
    focusSession('A') // P1 active

    // 在 A 分区操作：开 git tab
    useSideDrawer().open('git')
    expect(useSideDrawer().activeTab.value).toBe('git')

    // 切到 P2（B 变 active）—— B 作为 standby 期间无操作，其分区是默认态
    focusSession('B')
    const drawer = useSideDrawer()
    expect(drawer.isOpen.value).toBe(false) // B 默认态
    expect(drawer.activeTab.value).toBe('terminal')

    // 切回 P1（A），A 分区状态保留
    focusSession('A')
    expect(useSideDrawer().isOpen.value).toBe(true)
    expect(useSideDrawer().activeTab.value).toBe('git')
  })
})
