/**
 * initApp 默认选中上次 session 目录（W3 wave）。
 *
 * 背景：G1.1「沿用最近 session 目录做新任务」——initApp 的 presetCwd 应取**最近活跃
 * session 的 cwd**（sessionStore.list 中 lastActiveAt 最大者），而非当前的
 * workspaceStore.defaultCwd（最近工作区记录，可能与 session 目录不同步）。
 *
 * 当前实现（待改）：`const recentCwd = workspaceStore.defaultCwd; if (recentCwd) flow.presetCwd(recentCwd)`。
 * W3 改后：从 useSessionStore().list 取 lastActiveAt 最大 session.cwd；无 session 时回退
 * workspaceStore.defaultCwd。
 *
 * 红灯原因（实现未写，TDD 红灯合理）：
 * - IC-1: sessionStore 含多 session（lastActiveAt 不同），initApp 后 currentCwd 应是
 *   lastActiveAt 最大者的 cwd。当前实现用 workspaceStore.defaultCwd（与 session 无关），
 *   断言 currentCwd===最大 session 的 cwd 会 fail。
 *
 * 测试模式参考 app-bootstrap.test.ts：不 mock useNewTaskFlow（真实状态机），
 * mock @/api（session.list/create/switch/remove + chat.getHistory）+ workspaceStore，
 * session.list 返回带 lastActiveAt 的 SessionGroup[] 填充 sessionStore。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/initapp-default-cwd-session.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

// 可控依赖：session.list（填充 sessionStore）+ create/switch/remove（initApp 编排路径触达）
const sessionCtrl = vi.hoisted(() => ({
  list: vi.fn<() => Promise<SessionGroup[]>>(),
  create: vi.fn<(cwd?: string) => Promise<SessionSummary>>(),
  switchSession: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
  remove: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const chatCtrl = vi.hoisted(() => ({
  getHistory: vi.fn<(id: string) => Promise<unknown[]>>().mockResolvedValue([]),
}))

vi.mock('@/api', () => ({
  session: {
    list: sessionCtrl.list,
    create: sessionCtrl.create,
    switchSession: sessionCtrl.switchSession,
    remove: sessionCtrl.remove,
  },
  chat: { getHistory: chatCtrl.getHistory },
  extension: { scan: vi.fn().mockResolvedValue(undefined) },
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }) },
}))

// workspaceStore mock（W3 改后 defaultCwd 仅作兜底）
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

// useNewTaskFlow / useSidebar 真实实现（不 mock）
import { useSidebar, resetAppBootstrap } from '@/composables/features/useSidebar'
import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  resetAppBootstrap()
  vi.clearAllMocks()
  sessionCtrl.switchSession.mockResolvedValue(undefined)
  sessionCtrl.remove.mockResolvedValue(undefined)
  chatCtrl.getHistory.mockResolvedValue([])
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
})

function mkSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: over.id ?? 's',
    label: over.label ?? 'label',
    cwd: over.cwd ?? '/repo',
    status: 'idle',
    lastActiveAt: over.lastActiveAt ?? 0,
    modelId: 'm',
    tokenCount: 0,
    ...over,
  }
}

describe('initApp presetCwd：默认选中上次 session 目录（W3）', () => {
  it('IC-1: 有历史 session → presetCwd 用 lastActiveAt 最大 session 的 cwd', async () => {
    // 两个 session：/a（lastActiveAt=100）较旧，/b（lastActiveAt=200）最新
    // W3 改后应预填 /b（最大 lastActiveAt），与 workspaceStore.defaultCwd 无关
    sessionCtrl.list.mockResolvedValue([
      { cwd: '/a', sessions: [mkSession({ id: 'a', cwd: '/a', lastActiveAt: 100 })] },
      { cwd: '/b', sessions: [mkSession({ id: 'recent', cwd: '/b', lastActiveAt: 200 })] },
    ])
    // 故意把 defaultCwd 设成与最大 session 不同的值，证明预设源是 session 而非 workspace
    workspaceStoreMock.defaultCwd = '/fallback-from-workspace'

    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // 核心：currentCwd（pendingCwd 派生）= 最大 lastActiveAt session 的 cwd，不是 defaultCwd
    expect(flow.currentCwd.value).toBe('/b')
    expect(flow.currentCwd.value).not.toBe('/fallback-from-workspace')
  })

  it('IC-1b: 多个 session 跨多 cwd → 取全局 lastActiveAt 最大者（不局限第一个 cwd 组）', async () => {
    sessionCtrl.list.mockResolvedValue([
      {
        cwd: '/alpha',
        sessions: [
          mkSession({ id: 'a1', cwd: '/alpha', lastActiveAt: 500 }),
          mkSession({ id: 'a2', cwd: '/alpha', lastActiveAt: 999 }),
        ],
      },
      {
        cwd: '/beta',
        sessions: [mkSession({ id: 'b1', cwd: '/beta', lastActiveAt: 800 })],
      },
    ])

    await useSidebar().initApp()

    // 最大 lastActiveAt=999 → /alpha（不是 defaultCwd，也不是第一个 session）
    expect(useNewTaskFlow().currentCwd.value).toBe('/alpha')
  })

  it('IC-2: 无 session（sessionStore 空）→ 回退 workspaceStore.defaultCwd', async () => {
    sessionCtrl.list.mockResolvedValue([])
    workspaceStoreMock.defaultCwd = '/workspace-default'

    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    // 无 session 时回退 defaultCwd
    expect(flow.currentCwd.value).toBe('/workspace-default')
  })

  it('IC-3: session cwd 与 defaultCwd 都有时 → 优先 session（session 是「上次活跃」真源）', async () => {
    sessionCtrl.list.mockResolvedValue([
      { cwd: '/from-session', sessions: [mkSession({ id: 's1', cwd: '/from-session', lastActiveAt: 300 })] },
    ])
    workspaceStoreMock.defaultCwd = '/from-workspace'

    await useSidebar().initApp()

    // 优先 session 的 cwd
    expect(useNewTaskFlow().currentCwd.value).toBe('/from-session')
  })

  it('IC-4: 无 session 且无 defaultCwd → 不预填（currentCwd=null，首次启动空态）', async () => {
    sessionCtrl.list.mockResolvedValue([])
    workspaceStoreMock.defaultCwd = undefined

    await useSidebar().initApp()

    const flow = useNewTaskFlow()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBeNull()
  })

  it('IC-5: sessionStore.list 在 initApp 后被填充（loadSessions 副作用，验证数据源正确）', async () => {
    sessionCtrl.list.mockResolvedValue([
      { cwd: '/x', sessions: [mkSession({ id: 'x1', cwd: '/x', lastActiveAt: 42 })] },
    ])
    await useSidebar().initApp()

    // sessionStore.list（flatMap 后所有 session）应反映 loadSessions 拉取的数据
    const allSessions = useSessionStore().list
    expect(allSessions.some((s) => s.id === 'x1' && s.cwd === '/x')).toBe(true)
  })

  it('IC-6: 多个 session lastActiveAt 相同 → reduce 稳定取首个（数组中靠前胜出）', async () => {
    // 两个 session lastActiveAt 都是 300，cwd 不同；reduce 用 >= 取首个最大
    // 数组顺序 /first 在前 → currentCwd === '/first'
    sessionCtrl.list.mockResolvedValue([
      { cwd: '/first', sessions: [mkSession({ id: 'first', cwd: '/first', lastActiveAt: 300 })] },
      { cwd: '/second', sessions: [mkSession({ id: 'second', cwd: '/second', lastActiveAt: 300 })] },
    ])

    await useSidebar().initApp()

    expect(useNewTaskFlow().currentCwd.value).toBe('/first')
  })
})
