/**
 * useSidebar.deleteFolder 测试（W2TC2/W2TC3/W2TC4）。
 *
 * 锁定 folder 维度批量删除的核心行为：
 * - W2TC2：全成功时对 res.deleted 逐个 cleanupSessionState（removeFromList 被调），
 *           wasActiveInFolder=true 时回退（selectSession 或 navigation.push chat）
 * - W2TC3：部分失败时 deleteFolder 不 reject，返回值 failed.length 正确，removeFromList 仅对 deleted 调用
 * - W2TC4：removeByCwd reject 时 deleteFolder rejects，removeFromList 不被调
 *
 * mock 策略：参照 useSidebar-delete-cleanup.test.ts —— mock fileTree store + useChat +
 *   api 域（removeByCwd / switchSession / getCommands / getHistory）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useSidebar-deletefolder.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary } from '@xyz-agent/shared'

// ── mock fileTree store：捕获 clearSession（cleanupSessionState 副作用）──
const clearSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/stores/fileTree', () => ({
  useFileTreeStore: () => ({ clearSession: clearSessionMock }),
}))

// ── mock useChat composable：捕获 disposeSession（cleanupSessionState 副作用）──
const useChatDisposeMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({ disposeSession: useChatDisposeMock }),
}))

// ── mock api 域：removeByCwd 是 deleteFolder 的核心 WS 调用 ──
const removeByCwdMock = vi.hoisted(() => vi.fn())
const switchSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@/api', () => ({
  chat: {
    getHistory: vi.fn(() => Promise.resolve({ messages: [], historyTruncated: false })),
  },
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: switchSessionMock,
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    removeByCwd: removeByCwdMock,
    getCommands: vi.fn(() => Promise.resolve({ commands: [] })),
  },
}))

import { useSidebar } from '@/composables/features/useSidebar'
import { useSessionStore } from '@/stores/session'
import { useNavigationStore } from '@/stores/navigation'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'

function makeSummary(id: string, cwd = '/p'): SessionSummary {
  return { id, label: id, cwd, status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

/** 种入指定 cwd 下若干 session（单组） */
function seedSessions(ids: string[], cwd = '/p'): void {
  const store = useSessionStore()
  const group: SessionGroup = { cwd, sessions: ids.map((id) => makeSummary(id, cwd)) }
  store.setGroups([group])
}

beforeEach(() => {
  __clearSessionCleanupRegistryForTest()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  switchSessionMock.mockResolvedValue(undefined)
})

describe('useSidebar.deleteFolder 全成功（W2TC2）', () => {
  it('对 res.deleted 逐个 cleanupSessionState（clearSession/disposeSession 各 2 次），wasActiveInFolder 回退到 next', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    // folder('/p') 下 2 session：s1 persisted + s2 active
    seedSessions(['s1', 's2'])
    const session = useSessionStore()
    const panel = usePanelStore()
    panel.loadSession(ROOT_PANEL_ID, 's2')
    session.activeId = 's2'

    removeByCwdMock.mockResolvedValueOnce({
      cwd: '/p',
      deleted: ['s1', 's2'],
      failed: [],
    })
    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    const res = await sidebar.deleteFolder('/p')

    // WS 调用正确
    expect(removeByCwdMock).toHaveBeenCalledWith('/p')
    // 返回 BatchDeleteResult
    expect(res).toEqual({ cwd: '/p', deleted: ['s1', 's2'], failed: [] })
    // cleanupSessionState 对 s1 / s2 各调一次（clearSession + disposeSession 各 2 次）
    expect(clearSessionMock).toHaveBeenCalledWith('s1')
    expect(clearSessionMock).toHaveBeenCalledWith('s2')
    expect(useChatDisposeMock).toHaveBeenCalledWith('s1')
    expect(useChatDisposeMock).toHaveBeenCalledWith('s2')
    // wasActiveInFolder=true（s2 是 active 且在 folder 内）→ 回退（list 已空 → push chat）
    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })

    scope.stop()
  })
})

describe('useSidebar.deleteFolder 部分失败（W2TC3）', () => {
  it('deleteFolder 不 reject，返回 failed.length=1，cleanupSessionState 仅对 deleted 调用', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions(['s1', 's2'])
    // active 不在此 folder → wasActiveInFolder=false，不触发回退
    const session = useSessionStore()
    session.activeId = 'other'

    removeByCwdMock.mockResolvedValueOnce({
      cwd: '/p',
      deleted: ['s1'],
      failed: [{ sessionId: 's2', error: 'EPERM' }],
    })
    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    const res = await sidebar.deleteFolder('/p')

    // 不 reject（deleteFolder resolve）
    expect(res.cwd).toBe('/p')
    expect(res.deleted).toEqual(['s1'])
    expect(res.failed).toEqual([{ sessionId: 's2', error: 'EPERM' }])
    expect(res.failed.length).toBe(1)
    // cleanupSessionState 仅对 deleted 中的 's1' 调用（s2 在 failed，未删）
    expect(clearSessionMock).toHaveBeenCalledTimes(1)
    expect(clearSessionMock).toHaveBeenCalledWith('s1')
    expect(clearSessionMock).not.toHaveBeenCalledWith('s2')
    // wasActiveInFolder=false → 不回退
    expect(pushSpy).not.toHaveBeenCalled()

    scope.stop()
  })
})

describe('useSidebar.deleteFolder 网络异常（W2TC4）', () => {
  it('removeByCwd reject → deleteFolder rejects，cleanupSessionState 不被调', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    seedSessions(['s1', 's2'])

    removeByCwdMock.mockRejectedValueOnce(new Error('network'))

    await expect(sidebar.deleteFolder('/p')).rejects.toThrow('network')

    // WS 删除失败 → 不做任何本地清理
    expect(clearSessionMock).not.toHaveBeenCalled()
    expect(useChatDisposeMock).not.toHaveBeenCalled()

    scope.stop()
  })
})
