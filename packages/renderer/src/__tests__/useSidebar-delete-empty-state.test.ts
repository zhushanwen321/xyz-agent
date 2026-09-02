/**
 * useSidebarNew 删除路径空态出口单测（原 useSidebar 版迁移改指，u5.2；D5 显式行为变化承接）。
 *
 * [语义调整记录] 原 legacy useSidebar 的空态出口是 enterEmptyChatState()（push chat +
 * startFlow 进 landing）；useSidebarNew.deleteSession 自 w5 起代理 core（use-session.ts），
 * core 版空态出口只做 push({ view: 'chat' })，不启动 flow。设计 renderer-deepening D5 显式
 * 声明放弃 startFlow 兜底（删最后一个 session 后停留空 chat 态，用户点新建进 landing——
 * 46 个消费方线上早已是 core 语义，删 legacy = 消除分叉而非引入变化）。本测试改锁 core 语义。
 *
 * 覆盖：
 * - deleteSession / deleteFolder 的 4 处空态出口（各自删空分支 + S4 兜底分支）统一 push
 *   { view: 'chat' } 空态，且不编排 flow（state 停 idle）
 * - 成功回退路径（selectSession(next) 成功，经 core 12 步链含流订阅）不触发空态出口
 * - 排除保护：newSession 延迟 create 分支不调无参 startFlow——fallback cwd 保留不被清
 *
 * mock 策略：真实 useSidebarNew + 真实 useNewTaskFlow（app-bootstrap.test.ts 先例：不 mock
 * flow 状态机，防「组件层绿但 state 停 idle」盲区），只 mock @/api 域 + workspaceStore
 * + useChat（含 ensureStreamSubscription，隔离 WS 订阅噪音）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/useSidebar-delete-empty-state.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { SessionGroup, SessionSummary } from '@xyz-agent/shared'

// ── mock api 域（并集自 app-bootstrap / lru-panel-exempt 先例）──
const removeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const removeByCwdMock = vi.hoisted(() => vi.fn(() =>
  Promise.resolve({ cwd: '/proj', deleted: [] as string[], failed: [] })))
const switchSessionMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock('@/api', () => ({
  project: {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    save: vi.fn().mockResolvedValue(undefined),
  },
  chat: { getHistory: vi.fn(() => Promise.resolve({ messages: [], historyTruncated: false })), streamSubscribe: vi.fn(() => () => {}) },
  extension: {},
  session: {
    create: vi.fn(() => Promise.resolve(makeSummary('mock'))),
    list: vi.fn(() => Promise.resolve([])),
    switchSession: switchSessionMock,
    rename: vi.fn(() => Promise.resolve()),
    remove: removeMock,
    removeByCwd: removeByCwdMock,
    migrateImage: vi.fn(() => Promise.resolve({ migrated: [], failed: [] })),
    getCommands: vi.fn(() => Promise.resolve({ commands: [] })),
  },
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }), checkout: vi.fn(), checkoutByCwd: vi.fn(), createBranch: vi.fn() },
  workspace: { detect: vi.fn().mockResolvedValue({ mode: 'not-repo', isBareMode: false, wsRoot: '', repoRoot: '' }) },
  worktree: { list: vi.fn().mockResolvedValue([]) },
}))

// useChat mock：useSidebarNew cleanupSessionState / selectSession 与 useNewTaskFlow chat ports 共用；
// ensureStreamSubscription 隔离（真实实现 fire-and-forget WS 订阅，测试不需要）
const useChatMocks = vi.hoisted(() => ({
  disposeSession: vi.fn(),
  setHistoryTruncated: vi.fn(),
}))
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    disposeSession: useChatMocks.disposeSession,
    setHistoryTruncated: useChatMocks.setHistoryTruncated,
    send: vi.fn(),
    sendBash: vi.fn(),
  }),
  ensureStreamSubscription: vi.fn(),
}))

// workspaceStore mock：defaultCwd 可控（newSession fallback / useNewTaskFlow ports 共用）
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

import { useSidebarNew, resetSidebarNewForTest } from '@/composables/features/sidebar/useSidebarNew'
import { useNewTaskFlow, resetNewTaskFlow, __resetNewTaskFlowForTesting } from '@/composables/features/new-task/useNewTaskFlow'
import { useNavigationStore } from '@/stores/navigation'
import { useSessionStore } from '@/stores/session'

function makeSummary(id: string): SessionSummary {
  return { id, label: id, cwd: '/proj', status: 'idle', lastActiveAt: 1, modelId: 'm1', tokenCount: 0 }
}

function seedSessions(groups: Array<{ cwd: string; ids: string[] }>): void {
  const sessionGroups: SessionGroup[] = groups.map((g) => ({
    cwd: g.cwd,
    sessions: g.ids.map(makeSummary),
  }))
  useSessionStore().applySnapshot({ groups: sessionGroups })
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  __resetNewTaskFlowForTesting()
  resetSidebarNewForTest()
  vi.clearAllMocks()
  switchSessionMock.mockResolvedValue(undefined)
  removeMock.mockResolvedValue(undefined)
  removeByCwdMock.mockResolvedValue({ cwd: '/proj', deleted: [], failed: [] })
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
})

describe('deleteSession 空态出口（core 语义，D5 放弃 startFlow 兜底）', () => {
  it('D7-U1: 删唯一 session（删空分支）→ push chat 空态，不编排 flow（state 停 idle）', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebarNew())!
    seedSessions([{ cwd: '/proj', ids: ['s1'] }])
    useSessionStore().setActiveId('s1')

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    await sidebar.deleteSession('s1')

    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    // 核心断言：core 空态出口只 push 不启动 flow（D5 显式行为变化；用户点新建进 landing）
    expect(useNewTaskFlow().state.value).toBe('idle')

    scope.stop()
  })

  it('D7-U2: 删 active 后 selectSession(next) reject（S4 兜底分支）→ push chat 空态，flow 停 idle', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebarNew())!
    seedSessions([{ cwd: '/proj', ids: ['s1', 's2'] }])
    useSessionStore().setActiveId('s1')
    switchSessionMock.mockRejectedValue(new Error('network'))

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    await sidebar.deleteSession('s1')

    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    expect(useNewTaskFlow().state.value).toBe('idle')

    scope.stop()
  })

  it('D7-U3: 删 active 后 selectSession(next) 成功回退 → 不触发空态出口（flow 停 idle）', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebarNew())!
    seedSessions([{ cwd: '/proj', ids: ['s1', 's2'] }])
    useSessionStore().setActiveId('s1')

    await sidebar.deleteSession('s1')

    // 成功回退路径无空态出口：flow 不被编排（state 停 idle，非 landing）
    expect(useNewTaskFlow().state.value).toBe('idle')

    scope.stop()
  })
})

describe('deleteFolder 空态出口（core 语义，D5 放弃 startFlow 兜底）', () => {
  it('D7-U4: 删文件夹后列表空（删空分支）→ push chat 空态，不编排 flow', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebarNew())!
    seedSessions([{ cwd: '/proj', ids: ['s1'] }])
    useSessionStore().setActiveId('s1')
    removeByCwdMock.mockResolvedValue({ cwd: '/proj', deleted: ['s1'], failed: [] })

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    await sidebar.deleteFolder('/proj')

    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    expect(useNewTaskFlow().state.value).toBe('idle')

    scope.stop()
  })

  it('D7-U5: 删文件夹后 selectSession(next) reject（S4 兜底分支）→ push chat 空态，flow 停 idle', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebarNew())!
    seedSessions([
      { cwd: '/proj', ids: ['s1'] },
      { cwd: '/other', ids: ['s2'] },
    ])
    useSessionStore().setActiveId('s1')
    removeByCwdMock.mockResolvedValue({ cwd: '/proj', deleted: ['s1'], failed: [] })
    switchSessionMock.mockRejectedValue(new Error('network'))

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    await sidebar.deleteFolder('/proj')

    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    expect(useNewTaskFlow().state.value).toBe('idle')

    scope.stop()
  })
})

describe('newSession 延迟 create 分支排除保护（D7 排除说明）', () => {
  it('D7-U6: newSession 延迟 create 分支不调无参 startFlow——fallback cwd 保留不被清', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebarNew())!
    workspaceStoreMock.defaultCwd = '/repo'

    const navigation = useNavigationStore()
    const pushSpy = vi.spyOn(navigation, 'push')

    const created = await sidebar.newSession()

    expect(created).toBeNull() // 延迟 create，无 session
    expect(pushSpy).toHaveBeenCalledWith({ view: 'chat' })
    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // 排除保护核心：newSession 延迟 create 分支只 push 不重复 startFlow。若误用无参
    // startFlow 二次触发，pendingCwd 会被置 null，刚回灌的 fallback cwd 丢失。
    // landing 态无绑定 session，公开面 currentCwd 即 pendingCwd 的派生视图
    expect(flow.currentCwd.value).toBe('/repo')

    scope.stop()
  })
})
