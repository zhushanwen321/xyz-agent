/**
 * useSubagentListSync 单测 —— subagent 列表的响应式同步。
 *
 * 新设计（runtime push 取代 activityKey 轮询）：
 * - focusedSessionId 变化（切会话）→ clearSubagents + subscribeSubagentPush + 首拉 RPC 兜底
 * - subagents tab 激活 → loadSubagents 首拉
 * - runtime 主动推送 session.subagents → store 被动消费（subscribeSubagentPush 订阅）
 *
 * activityKey 实时刷新 watch 已删除（被 runtime push 取代）。
 *
 * 运行：npx vitest run src/__tests__/composables/useSubagentListSync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick } from 'vue'

// mock sessionApi（loadSubagents 内部调用）
vi.mock('@/api/domains/session', () => ({
  getSubagents: vi.fn().mockResolvedValue([]),
  getSubagentHistory: vi.fn().mockResolvedValue([]),
}))

import { useSubagentListSync } from '@/composables/features/useSubagentListSync'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useSubagentStore } from '@/stores/subagent'
import * as sessionApi from '@/api/domains/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/**
 * 在 effectScope 内激活 composable 的 watch，返回 scope 以便手动 stop。
 */
function activateSync(): ReturnType<typeof effectScope> {
  const scope = effectScope()
  scope.run(() => {
    useSubagentListSync()
  })
  return scope
}

/** 设置 panel store 的 active panel 绑定指定 session */
function setPanelSession(panel: ReturnType<typeof usePanelStore>, sessionId: string | null): void {
  panel.loadSession(ROOT_PANEL_ID, sessionId)
}

describe('useSubagentListSync — 切会话触发 clearSubagents + 首拉', () => {
  it('focusedSessionId 变化时 clearSubagents 被调用（清空旧数据）', async () => {
    const panel = usePanelStore()
    const subagentStore = useSubagentStore()
    // 先绑一个 session（immediate watch 会首拉），scope 停后再测切换
    setPanelSession(panel, 'session-init')
    const scope = activateSync()

    // 预置旧数据
    subagentStore.records = [{ subagentId: 'old', agent: 'a', slug: 's', task: 't', status: 'done', sessionFile: null }]
    expect(subagentStore.records).toHaveLength(1)

    // 切会话 → clearSubagents 清空
    setPanelSession(panel, 'session-new')
    await nextTick()

    expect(subagentStore.records).toEqual([])
    scope.stop()
  })

  it('focusedSessionId 变化时 loadSubagents 被调用（首拉兜底）', async () => {
    const panel = usePanelStore()
    setPanelSession(panel, 'session-init')
    const scope = activateSync()
    vi.clearAllMocks() // 清掉 immediate 的首拉

    setPanelSession(panel, 'session-2')
    await vi.waitFor(() => {
      expect(sessionApi.getSubagents).toHaveBeenCalledWith('session-2')
    })

    scope.stop()
  })
})

describe('useSubagentListSync — subagents tab 激活触发 loadSubagents', () => {
  it('tab=subagents + focusedSessionId 有值 → loadSubagents 被调用', async () => {
    const panel = usePanelStore()
    const sidebar = useSidebarStore()
    setPanelSession(panel, 'session-1')
    const scope = activateSync()
    vi.clearAllMocks()

    sidebar.activeTab = 'subagents'
    await vi.waitFor(() => {
      expect(sessionApi.getSubagents).toHaveBeenCalledWith('session-1')
    })

    scope.stop()
  })
})

describe('useSubagentListSync — landing 态不加载', () => {
  it('focusedSessionId=null（landing 态）→ loadSubagents 不被调用', async () => {
    const panel = usePanelStore()
    // panel 初始 sessionId=null（不预设 session）
    const scope = activateSync()

    await new Promise((r) => setTimeout(r, 50))
    expect(sessionApi.getSubagents).not.toHaveBeenCalled()

    scope.stop()
  })
})
