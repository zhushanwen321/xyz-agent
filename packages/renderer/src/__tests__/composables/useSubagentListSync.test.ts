/**
 * useSubagentListSync 单测 —— subagent 列表的响应式同步。
 *
 * 覆盖：
 * - focusedSessionId 变化（切会话）→ clearSubagents 先清空
 * - subagents tab 激活 + focusedSessionId 有值 → loadSubagents 加载
 * - 非 subagents tab → 不触发 loadSubagents
 * - activityKey 变化（subagent tool_call 出现）→ loadSubagents 刷新
 *
 * 运行：npx vitest run src/__tests__/composables/useSubagentListSync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick } from 'vue'
import type { Message } from '@xyz-agent/shared'

// mock sessionApi（loadSubagents 内部调用）
vi.mock('@/api/domains/session', () => ({
  getSubagents: vi.fn().mockResolvedValue([]),
  getSubagentHistory: vi.fn().mockResolvedValue([]),
}))

import { useSubagentListSync } from '@/composables/features/useSubagentListSync'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSidebarStore } from '@/stores/sidebar'
import { useChatStore } from '@/stores/chat'
import { useSubagentStore } from '@/stores/subagent'
import * as sessionApi from '@/api/domains/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/**
 * 在 effectScope 内激活 composable 的 watch，返回 scope 以便手动 stop。
 * composable 的 watch 需要在活跃的 effect scope 内才能注册。
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

/** 向 chatStore 注入消息（驱动 activityKey） */
function seedMessages(chat: ReturnType<typeof useChatStore>, sessionId: string, msgs: Message[]): void {
  chat.setMessages(sessionId, msgs)
}

describe('useSubagentListSync — 切会话触发 clearSubagents', () => {
  it('focusedSessionId 变化时 clearSubagents 被调用（清空旧数据）', async () => {
    const panel = usePanelStore()
    const subagentStore = useSubagentStore()
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
})

describe('useSubagentListSync — subagents tab 激活触发 loadSubagents', () => {
  it('tab=subagents + focusedSessionId 有值 → loadSubagents 被调用', async () => {
    const panel = usePanelStore()
    const sidebar = useSidebarStore()
    setPanelSession(panel, 'session-1')
    const scope = activateSync()

    // activateSync 后改 tab 值 → watch 检测到变化 → 触发 loadSubagents
    sidebar.activeTab = 'subagents'
    await vi.waitFor(() => {
      expect(sessionApi.getSubagents).toHaveBeenCalledWith('session-1')
    })

    scope.stop()
  })

  it('tab=sessions（非 subagents）→ loadSubagents 不被调用', async () => {
    const panel = usePanelStore()
    const sidebar = useSidebarStore()
    setPanelSession(panel, 'session-1')
    const scope = activateSync()

    // 保持 sessions tab（默认值），改一下确认不触发
    sidebar.activeTab = 'files'
    await new Promise((r) => setTimeout(r, 50))
    expect(sessionApi.getSubagents).not.toHaveBeenCalled()

    scope.stop()
  })
})

describe('useSubagentListSync — activityKey 变化触发刷新', () => {
  it('subagents tab 激活时，新 subagent tool_call 到达 → loadSubagents 刷新', async () => {
    const panel = usePanelStore()
    const sidebar = useSidebarStore()
    const chat = useChatStore()
    setPanelSession(panel, 'session-1')
    const scope = activateSync()

    // activate 后切到 subagents tab → 首次加载
    // 注：tab watch 和 activityKey watch 都监听 activeTab，可能触发 2 次（预期行为）
    sidebar.activeTab = 'subagents'
    await vi.waitFor(() => {
      expect(sessionApi.getSubagents).toHaveBeenCalled()
    })
    const firstCallCount = vi.mocked(sessionApi.getSubagents).mock.calls.length

    // 注入含 subagent toolCall 的消息 → activityKey 变化 → 触发刷新
    const msgWithSubagent: Message = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{ id: 'tc1', toolName: 'subagent', input: {}, status: 'done' }],
    }
    seedMessages(chat, 'session-1', [msgWithSubagent])

    await vi.waitFor(() => {
      expect(vi.mocked(sessionApi.getSubagents).mock.calls.length).toBeGreaterThan(firstCallCount)
    })

    scope.stop()
  })
})

describe('useSubagentListSync — focusedSessionId 为 null 时不加载', () => {
  it('landing 态（sessionId=null）→ loadSubagents 不被调用', async () => {
    const panel = usePanelStore()
    const sidebar = useSidebarStore()
    // panel sessionId 为 null（landing 态）
    setPanelSession(panel, null)
    sidebar.activeTab = 'subagents'

    const scope = activateSync()

    await new Promise((r) => setTimeout(r, 50))
    expect(sessionApi.getSubagents).not.toHaveBeenCalled()

    scope.stop()
  })
})
