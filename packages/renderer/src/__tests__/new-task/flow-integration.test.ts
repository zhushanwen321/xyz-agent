/**
 * useNewTaskFlow 主流程 + 选目录 + submitFirstMessage 集成测试
 * （#1+#3+#4+#5，需求修正后「统一延迟 create」语义）。
 *
 * 集成边界：mock 最外层 @/api（session.create/remove）+ lib/ipc（pickDirectory）+
 * @/composables/features/useChat（chat.send），真用 useSessionStore/usePanelStore/
 * useNavigationStore/resolveDefaultCwd。验证跨层数据流。
 *
 * 需求修正后的新语义（真相源）：
 * - startFlow 统一延迟 create：所有场景点新建只 transition('landing')+currentSession=null+pendingCwd=null，不调 create
 * - selectWorkspace/openDirDialog 只记 pendingCwd（不 delete/create session），首发提交才建 session
 * - submitFirstMessage（landing 态首发）：create+appendSession+activeId+loadSession+navigation.push+send+completed
 *
 * 覆盖（选目录 #5）：
 * - T3.1 selectWorkspace：cwd 变→只记 pendingCwd（延迟 create）；cwd 未变→noop
 * - T3.3 openDirDialog：pickDirectory canceled=false→只记 pendingCwd（延迟 create）
 * - T3.4 openDirDialog：canceled=true→落回 dir-popover，cwd 不变，不 create
 * - T3.5 E5 IPC 抛错：pickDirectory reject→openDirDialog reject 显错不崩、state 落回不卡死
 * 覆盖（submitFirstMessage 延迟 create）：
 * - 首发提交→create+载入 panel+push 导航+send+completed
 * - cwd 来源：pendingCwd 优先 / 否则 resolveDefaultCwd
 * - 重试场景（currentSession 已存在）→跳过 create 直接 send
 * - create reject→错误向上抛、不留僵尸 session
 * - 非法态（非 landing）提交→抛错
 * - 双击并发→in-flight 守卫 create 只调一次
 *
 * 新设计下 landing 态 gitInfo 恒 null（无 session）→ branch 链路不可达，
 * 原 selectBranch/confirmDirtySwitch/submitCreateBranch 集成测试已删（组件层单测见 create-branch-modal.test.ts）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/new-task/flow-integration.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@xyz-agent/shared'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

// 可控依赖：测试按需让 create/pickDirectory/chat.send pending/resolve/reject
const createCtrl = vi.hoisted(() => ({
  // submitFirstMessage（延迟 create）会调 create，需返回有效值
  create: vi.fn<(cwd?: string) => Promise<SessionSummary>>().mockImplementation((cwd) =>
    Promise.resolve({
      id: `s-${Math.random().toString(36).slice(2, 8)}`,
      label: '新会话',
      cwd: cwd ?? '/repo',
      status: 'idle',
      lastActiveAt: Date.now(),
      modelId: 'm',
      tokenCount: 0,
    }),
  ),
  remove: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const pickCtrl = vi.hoisted(() => ({
  pickDirectory: vi.fn<() => Promise<{ canceled: boolean; path: string | null }>>(),
}))
const chatMock = vi.hoisted(() => ({
  send: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
}))

vi.mock('@/api', () => ({
  session: {
    create: createCtrl.create,
    remove: createCtrl.remove,
    // PR #87：submitFirstMessage 现调 sessionApi.getCommands（兜底拉取 slash 命令）；
    // loadSubagents/loadWorkflows 也在首发路径内。给空返回避免 unhandled rejection。
    getCommands: vi.fn().mockResolvedValue({ commands: [] }),
    getSubagents: vi.fn().mockResolvedValue([]),
    getWorkflows: vi.fn().mockResolvedValue([]),
  },
  // submitFirstMessage → useFileTree.loadTree 调 fileApi.tree/gitApi.status（Promise.allSettled）；
  // 给空返回避免 unhandled rejection
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }) },
}))
vi.mock('@/lib/ipc', () => ({ pickDirectory: pickCtrl.pickDirectory }))
// submitFirstMessage 终端调用 useChat.send；mock 掉避免拖入 chat 订阅机制（useChat 自有单测）
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => chatMock,
}))

// W3: mock workspaceStore 让 submitFirstMessage 能取到 defaultCwd
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
  record: vi.fn(),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'
import { usePanelStore } from '@/stores/panel'
import { useNavigationStore } from '@/stores/navigation'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
  createCtrl.remove.mockResolvedValue(undefined)
  chatMock.send.mockResolvedValue(undefined)
  // 重置 workspaceStore mock
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
  workspaceStoreMock.record.mockResolvedValue(undefined)
})

function setGroups(sessions: SessionSummary[]): void {
  const byCwd = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const arr = byCwd.get(s.cwd) ?? []
    arr.push(s)
    byCwd.set(s.cwd, arr)
  }
  useSessionStore().setGroups(
    Array.from(byCwd, ([cwd, ss]): SessionGroup => ({ cwd, sessions: ss })),
  )
}

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

describe('⌘N 主流程（startFlow 统一延迟 create）', () => {
  it('T1.1 startFlow→不 create→state=landing，currentSessionId=null，currentCwd=null（空 chip 态）', async () => {
    setGroups([
      mkSession({ id: 'old', cwd: '/last-repo', lastActiveAt: 100 }),
      mkSession({ id: 'recent', cwd: '/recent-repo', lastActiveAt: 900 }),
    ])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    // 统一延迟 create：点新建不立即建 session（推翻原「触发即创建」+「非首次沿用上次 cwd」）
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentSessionId.value).toBeNull()
    expect(flow.currentCwd.value).toBeNull() // pendingCwd 清空 → 空 chip 态
  })
})

describe('选目录链路（selectWorkspace / openDirDialog，#5）', () => {
  it('T3.1 cwd 变→只记 pendingCwd（延迟 create，不建 session），chip 回灌新 cwd', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover() // landing→dir-popover

    createCtrl.remove.mockClear()
    createCtrl.create.mockClear()
    await flow.selectWorkspace('/other-repo')

    // 延迟 create：选目录不建 session（首发提交才建），只记 pendingCwd
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(createCtrl.remove).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/other-repo') // chip 回灌 pendingCwd
    expect(flow.currentSessionId.value).toBeNull() // 恒 null
  })

  it('T3.1 cwd 未变→noop（不重复操作，仅关 popover）', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    await flow.selectWorkspace('/repo') // 首次记 pendingCwd
    expect(flow.currentCwd.value).toBe('/repo')

    flow.openDirPopover()
    createCtrl.create.mockClear()
    createCtrl.remove.mockClear()
    await flow.selectWorkspace('/repo') // 同值→noop
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(createCtrl.remove).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing') // 仅关 popover
    expect(flow.currentCwd.value).toBe('/repo')
  })
})

describe('OS dialog 分支（openDirDialog，#5）', () => {
  it('T3.3 pickDirectory canceled=false→只记 pendingCwd（延迟 create，不建 session），chip 回灌新 cwd', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    pickCtrl.pickDirectory.mockResolvedValue({ canceled: false, path: '/picked-dir' })

    createCtrl.remove.mockClear()
    createCtrl.create.mockClear()
    await flow.openDirDialog()

    // 延迟 create：选中目录不建 session，只记 pendingCwd
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(createCtrl.remove).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/picked-dir') // chip 回灌 pendingCwd
    expect(flow.currentSessionId.value).toBeNull()
  })

  it('T3.4 pickDirectory canceled=true→落回 dir-popover，cwd 不变，不 create', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    await flow.selectWorkspace('/preselected') // 先记 pendingCwd（currentCwd=/preselected）
    flow.openDirPopover()
    pickCtrl.pickDirectory.mockResolvedValue({ canceled: true, path: null })

    createCtrl.create.mockClear()
    await flow.openDirDialog()

    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('dir-popover') // 落回
    expect(flow.currentCwd.value).toBe('/preselected') // cwd 不变
  })

  it('T3.5 E5 pickDirectory reject→openDirDialog reject 显错不崩、state 落回不卡死', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    pickCtrl.pickDirectory.mockRejectedValue(new Error('getFocusedWindow null'))
    await expect(flow.openDirDialog()).rejects.toThrow('getFocusedWindow null')
    // 显错向上抛（调用方接 toast），state 不卡在 dir-dialog
    expect(flow.state.value).toBe('dir-popover') // 落回
  })
})

describe('submitFirstMessage（landing 态首发提交：延迟 create+载入+发送）', () => {
  it('首发提交→create session + appendSession + activeId + loadSession + navigation.push + send + transition completed', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
    workspaceStoreMock.defaultCwd = '/repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 'new-1', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    const session = useSessionStore()
    const panel = usePanelStore()
    const navigation = useNavigationStore()
    await flow.startFlow()
    expect(session.activeId).toBeNull()

    await flow.submitFirstMessage('hello world')

    // create 用 workspaceStore.defaultCwd（最近工作区 cwd=/repo）；label=提示词前10字（'hello world' 11 字符 → 截断+省略号）
    expect(createCtrl.create).toHaveBeenCalledWith('/repo', 'hello worl…')
    expect(session.activeId).toBe('new-1') // activeId 绑定
    expect(session.list.map((s) => s.id)).toContain('new-1') // appendSession 入组
    // panel 载入 active panel
    expect(panel.findPanelBySession('new-1')).not.toBeNull()
    // navigation push chat view
    expect(navigation.current.view).toBe('chat')
    expect(navigation.current.sessionId).toBe('new-1')
    // chat.send 被调用（显式 sid + trimmed 转 Segment[]，ADR-0037）
    expect(chatMock.send).toHaveBeenCalledWith('new-1', textToSegments('hello world'))
    expect(flow.state.value).toBe('completed')
  })

  it('cwd 来源：pendingCwd 优先于 workspaceStore.defaultCwd', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/last-repo', lastActiveAt: 900 })])
    // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
    workspaceStoreMock.defaultCwd = '/last-repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 's-pending', cwd: '/picked' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    await flow.selectWorkspace('/picked') // 记 pendingCwd=/picked

    await flow.submitFirstMessage('go')

    // create 用 pendingCwd（/picked），而非 workspaceStore.defaultCwd（/last-repo）；label='go'（≤10 原文）
    expect(createCtrl.create).toHaveBeenCalledWith('/picked', 'go')
  })

  it('cwd 来源：无 pendingCwd 时用 workspaceStore.defaultCwd', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/last-repo', lastActiveAt: 900 })])
    // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
    workspaceStoreMock.defaultCwd = '/last-repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 's-default', cwd: '/last-repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow() // 未选目录 → pendingCwd=null

    await flow.submitFirstMessage('go')

    // create 用 workspaceStore.defaultCwd（最近活跃 cwd=/last-repo）；label='go'（≤10 原文）
    expect(createCtrl.create).toHaveBeenCalledWith('/last-repo', 'go')
  })

  it('重试场景（currentSession 已存在）→跳过 create 直接 send', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    createCtrl.create.mockResolvedValueOnce(mkSession({ id: 'retry-s', cwd: '/repo' }))
    // 首次提交：create 成功但 send 失败（模拟重试场景）
    chatMock.send.mockRejectedValueOnce(new Error('network down'))
    const flow = useNewTaskFlow()
    await flow.startFlow()
    await expect(flow.submitFirstMessage('first')).rejects.toThrow('network down')
    expect(createCtrl.create).toHaveBeenCalledTimes(1)
    expect(flow.currentSessionId.value).toBe('retry-s') // session 已绑定
    expect(flow.state.value).toBe('landing') // send 失败未进 completed

    // 重试：currentSession 已存在 → 跳过 create，直接 send
    chatMock.send.mockResolvedValueOnce(undefined)
    await flow.submitFirstMessage('first')
    expect(createCtrl.create).toHaveBeenCalledTimes(1) // 未重复 create
    expect(chatMock.send).toHaveBeenCalledTimes(2)
    expect(flow.state.value).toBe('completed')
  })

  it('E2/E3 create reject→错误向上抛，不留僵尸 session（state 留 landing，currentSession=null）', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/etc/nonexistent', lastActiveAt: 1 })])
    createCtrl.create.mockRejectedValue(new Error('invalid cwd'))
    const flow = useNewTaskFlow()
    await flow.startFlow()

    await expect(flow.submitFirstMessage('hi')).rejects.toThrow('invalid cwd')

    expect(createCtrl.create).toHaveBeenCalledTimes(1)
    expect(flow.currentSessionId.value).toBeNull() // 不绑定僵尸 session
    expect(flow.state.value).toBe('landing') // 留 landing 可重试（未进 completed）
    expect(chatMock.send).not.toHaveBeenCalled() // create 失败未发消息
  })

  it('非 landing 态提交→抛错', async () => {
    const flow = useNewTaskFlow()
    // state=idle（未 startFlow），非 landing
    await expect(flow.submitFirstMessage('hi')).rejects.toThrow('非 landing')
    expect(createCtrl.create).not.toHaveBeenCalled()
  })

  it('双击并发→in-flight 守卫，create 只调一次', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    let resolveCreate!: (s: SessionSummary) => void
    createCtrl.create.mockReturnValueOnce(
      new Promise<SessionSummary>((r) => {
        resolveCreate = r
      }),
    )
    const flow = useNewTaskFlow()
    await flow.startFlow()
    const p1 = flow.submitFirstMessage('one')
    const p2 = flow.submitFirstMessage('two') // in-flight 守卫→直接 return
    resolveCreate(mkSession({ id: 'solo', cwd: '/repo' }))
    await p1
    await p2
    expect(createCtrl.create).toHaveBeenCalledTimes(1)
  })
})

describe('sessionStore 同步（延迟 create：startFlow 不联动 store）', () => {
  it('startFlow 不 create：无论有无历史 session，activeId 不变（null）+ currentSessionId=null', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const store = useSessionStore()
    expect(store.activeId).toBeNull()

    const flow = useNewTaskFlow()
    await flow.startFlow()

    // startFlow 延迟 create：不同步 sessionStore（首发提交 submitFirstMessage 才绑定）
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentSessionId.value).toBeNull()
    expect(store.activeId).toBeNull() // 未被同步
  })
})
