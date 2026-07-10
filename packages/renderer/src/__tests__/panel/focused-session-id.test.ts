/**
 * focusedSessionId 派生测试 —— panel focus 切换时 UI 焦点 session 跟随（核心 bug 回归）。
 *
 * 锁定：split panel 下切 panel focus（panel.setActive）时，focusedSessionId 从
 * activePanelId 派生，自动跟随。sidebar 高亮 / 文件树 / overview 均读 focusedSessionId，
 * 不再读 session.activeId（activeId 收敛为导航语义）。
 *
 * bug 背景：此前 sidebar 高亮读 session.activeId，panel focus 切换只改 panel.activePanelId，
 * 不改 session.activeId → 高亮不动。引入 focusedSessionId（从 activePanelId 派生）修复。
 *
 * 覆盖：
 * - T1：单 panel，leaf.sessionId='s1' → focusedSessionId='s1'
 * - T2：split 双 panel，setActive 切焦点 → focusedSessionId 跟随（核心回归）
 * - T3：standby 空态（leaf.sessionId=null）→ focusedSessionId=null
 * - T4：focusedSession 按 id 查 session.list（FileView label/branch 数据源）
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/focused-session-id.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary } from '@xyz-agent/shared'

// features 层调用 api 域；本测试只验 focusedSessionId 派生，mock 成 no-op。
vi.mock('@/api', () => ({
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    getCommands: vi.fn(() => Promise.resolve({ commands: [] })),
  },
}))

import { useSidebar } from '@/composables/features/useSidebar'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'

function makeSummary(id: string): SessionSummary {
  return { id, label: `session-${id}`, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

function seedSession(s: SessionSummary): void {
  const store = useSessionStore()
  const group: SessionGroup = { cwd: s.cwd, sessions: [s] }
  store.setGroups([group])
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('focusedSessionId 派生（panel focus → UI 焦点 session）', () => {
  it('T1: 单 panel，leaf.sessionId=s1 → focusedSessionId=s1', () => {
    const panel = usePanelStore()
    seedSession(makeSummary('s1'))
    panel.loadSession(ROOT_PANEL_ID, 's1')

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    expect(sidebar.focusedSessionId.value).toBe('s1')
    scope.stop()
  })

  it('T2: split 双 panel，setActive 切焦点 → focusedSessionId 跟随（核心 bug 回归）', () => {
    const panel = usePanelStore()
    seedSession(makeSummary('s1'))
    seedSession(makeSummary('s2'))
    panel.loadSession(ROOT_PANEL_ID, 's1')
    panel.split()
    const [, right] = panel.panels
    panel.loadSession(right.id, 's2')

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    // 初始 active=left → focusedSessionId=s1
    expect(sidebar.focusedSessionId.value).toBe('s1')
    // 切焦点到右 panel → focusedSessionId=s2（修复前此处仍为 s1）
    panel.setActive(right.id)
    expect(sidebar.focusedSessionId.value).toBe('s2')
    // 切回左 panel → focusedSessionId=s1
    panel.setActive(ROOT_PANEL_ID)
    expect(sidebar.focusedSessionId.value).toBe('s1')
    scope.stop()
  })

  it('T3: standby 空态（leaf.sessionId=null）→ focusedSessionId=null', () => {
    const panel = usePanelStore()
    seedSession(makeSummary('s1'))
    panel.loadSession(ROOT_PANEL_ID, 's1')
    panel.split() // 右 panel 空（sessionId=null）
    const [, right] = panel.panels

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    // 初始 active=left(s1) → focusedSessionId=s1
    expect(sidebar.focusedSessionId.value).toBe('s1')
    // 切到空 standby panel → focusedSessionId=null（文件树显空态）
    panel.setActive(right.id)
    expect(sidebar.focusedSessionId.value).toBe(null)
    scope.stop()
  })

  it('T4: focusedSession 按 focusedSessionId 查 session.list（FileView label 数据源）', () => {
    const panel = usePanelStore()
    seedSession(makeSummary('s1'))
    panel.loadSession(ROOT_PANEL_ID, 's1')

    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    expect(sidebar.focusedSession.value?.label).toBe('session-s1')
    // focusedSessionId 指向不存在的 session → focusedSession=null
    panel.loadSession(ROOT_PANEL_ID, 'nonexistent')
    expect(sidebar.focusedSession.value).toBe(null)
    scope.stop()
  })
})
