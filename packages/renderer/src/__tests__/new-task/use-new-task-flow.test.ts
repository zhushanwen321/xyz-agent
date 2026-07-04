/**
 * useNewTaskFlow 状态机单测（#3，需求修正后「统一延迟 create」语义）。
 *
 * 覆盖（纯状态机守卫）：
 * - T1.2 startFlow→不调 create、state=landing、currentSessionId=null（统一延迟 create）
 * - T7.1 gitInfo==null→openBranchPopover 抛错回 idle
 * - T8.3 overlay 态 cancelFlow→cancelled
 * - T8.4 cancelled 重入 reenterFlow→landing
 * - T8.5 completed 终态→⌘N→销毁重建 idle→landing（startFlow 不 create，只 transition）
 * - T8.6 非法转换 idle→openBranchModal 抛错回 idle
 * - T6.5 openBranchModal 来源守卫：非 branch-popover 来源抛错回 idle
 *
 * 新设计下 landing 态 gitInfo 恒 null（统一延迟 create 后无 session）→
 * branch-popover/branch-modal 不可达。原 overlay 互斥（T8.1）、Esc 优先级（T8.2）、
 * branch-modal 来源正向、Esc 排队（T4.8）等依赖 branch 链路的测试已删（场景不可达）。
 * branch 组件层单测见 create-branch-modal.test.ts。
 *
 * mock 策略：vi.hoisted + vi.mock('@/api')（session.create/remove），真用 useSessionStore + resolveDefaultCwd。
 * beforeEach 重建 pinia + clearAllMocks；每测唯一 sid。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/new-task/use-new-task-flow.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

const apiMock = vi.hoisted(() => ({
  create: vi.fn(
    (cwd?: string): Promise<SessionSummary> =>
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
  remove: vi.fn((): Promise<void> => Promise.resolve()),
  // submitFirstMessage → useChat.send → chatApi.send/streamSubscribe 需要 mock 占位
  chatSend: vi.fn((): Promise<void> => Promise.resolve()),
  streamSubscribe: vi.fn((): (() => void) => () => {}),
}))

vi.mock('@/api', () => ({
  session: { create: apiMock.create, remove: apiMock.remove },
  git: {},
  chat: { send: apiMock.chatSend, streamSubscribe: apiMock.streamSubscribe },
}))

// W3: mock workspaceStore 让 submitFirstMessage 能取到 defaultCwd
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
}))

// INV-7: mock useToast 捕获 toastError 调用（cwd fallback 通知）
const toastMock = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastMock.error }),
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  vi.clearAllMocks()
  // 重置 workspaceStore mock
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
})

/** 构造带 gitBranch 的 session（git 目录） */
function gitSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: over.id ?? 'git-s',
    label: over.label ?? 'repo',
    cwd: over.cwd ?? '/repo',
    gitBranch: over.gitBranch ?? 'main',
    status: 'idle',
    lastActiveAt: over.lastActiveAt ?? 100,
    modelId: 'm',
    tokenCount: 0,
  }
}

function setGroups(sessions: SessionSummary[]): void {
  // 同 cwd 归一组（与 store.appendSession 语义一致）
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

describe('useNewTaskFlow 状态机', () => {
  describe('startFlow 首次启动边界（T1.2）', () => {
    it('sessions=[]→cwd=undefined→不调 create、currentSessionId=null、state=landing', async () => {
      setGroups([]) // 首次启动无历史
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(apiMock.create).not.toHaveBeenCalled()
      expect(flow.currentSessionId.value).toBeNull()
      expect(flow.state.value).toBe('landing')
    })
  })

  /**
   * submitFirstMessage label 派生：session 名默认取首条提示词前 10 字符 + 省略号，
   * 取代旧的 basename(cwd)。防护：未来若误把 label 传成 undefined/cwd，侧栏与目录列表
   * 会回退到目录名，与产品诉求「提示词前 10 字」背离，本块立刻红。
   */
  describe('submitFirstMessage label 派生（session 名 = 提示词前 10 字）', () => {
    it('未选目录直接发送 → create 收到 (cwd, label)，label 是提示词前 10 字', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage('一二三四五六七八九十十一') // 11 字
      expect(apiMock.create).toHaveBeenCalledTimes(1)
      // cwd 兑底用最近 session 的 /repo；label 截断为前 10 字 + 省略号
      expect(apiMock.create).toHaveBeenCalledWith('/repo', '一二三四五六七八九十…')
    })

    it('短提示词 → label = 原文（不加省略号），与提示词一致', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage('修 bug') // 4 字
      expect(apiMock.create).toHaveBeenCalledWith('/repo', '修 bug')
    })

    it('selectedWorkspace 选定 cwd 后发送 → create 第 1 参数用选定 cwd 而非兑底', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover() // landing→dir-popover（selectWorkspace 须从 dir-popover 调用）
      await flow.selectWorkspace('/custom/path') // dir-popover→landing，记 pendingCwd
      await flow.submitFirstMessage('hello world!')
      expect(apiMock.create).toHaveBeenCalledWith('/custom/path', 'hello worl…')
    })
  })

  /**
   * INV-7 / D-008: submitFirstMessage create 后比对 cwd 判断 runtime 是否降级 homedir，
   * fallback 则 toastError。真实断言（修正 T4.4 只测 emit 格式的语义偷换）。
   */
  describe('submitFirstMessage cwd fallback toast（INV-7, D-008）', () => {
    it('create 返回 cwd != 请求 cwd（runtime 降级 homedir）→ toastError 被调且文案含原 cwd', async () => {
      // 模拟 runtime create 因 cwd 失效降级：返回的 session.cwd 与请求 cwd 不一致
      apiMock.create.mockResolvedValueOnce({
        id: 'fallback-s', label: 'x', cwd: '/home/user',
        status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0,
      })
      setGroups([gitSession({ id: 'hist', cwd: '/gone', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/gone'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage('hello')
      // create 用兑底 cwd 调用
      expect(apiMock.create).toHaveBeenCalledWith('/gone', expect.any(String))
      // toast 触发一次，文案含「已不存在」+ 原 cwd
      expect(toastMock.error).toHaveBeenCalledTimes(1)
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('已不存在'))
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('/gone'))
    })

    it('create 返回 cwd == 请求 cwd（目录存在，未降级）→ 不 toast', async () => {
      // apiMock.create 默认实现返回 cwd = 传入 cwd，一致，不触发 toast
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage('hello')
      expect(toastMock.error).not.toHaveBeenCalled()
    })

    it('未选目录且 defaultCwd=undefined（cwd 为空）→ 不比对、不 toast', async () => {
      // cwd 守卫：cwd 为 undefined 时不进入比对分支
      setGroups([])
      workspaceStoreMock.defaultCwd = undefined
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage('hello')
      expect(toastMock.error).not.toHaveBeenCalled()
    })
  })

  describe('UC-7 非 git 守卫（T7.1）', () => {
    it('landing 态 currentSession=null→gitInfo 派生 null→openBranchPopover 抛错回 idle', async () => {
      // 统一延迟 create：landing 态无绑定 session → gitInfo 恒 null（与目录是否 git 无关）
      setGroups([
        {
          id: 'git-history',
          label: 'repo',
          cwd: '/repo',
          gitBranch: 'main',
          status: 'idle',
          lastActiveAt: 100,
          modelId: 'm',
          tokenCount: 0,
        },
      ])
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.gitInfo.value).toBeNull()
      expect(() => flow.openBranchPopover()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  // 新设计下 landing 态 gitInfo 恒 null → branch-popover/branch-modal 不可达，
  // 原 overlay 互斥（T8.1）/ Esc 优先级（T8.2）依赖 branch 链路的测试已删（场景不可达）。

  describe('overlay 切 session（T8.3）', () => {
    it('overlay 打开→cancelFlow→cancelled（不卡死）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      flow.cancelFlow() // 切 session 触发
      expect(flow.state.value).toBe('cancelled')
    })
  })

  describe('cancelled 重入（T8.4）', () => {
    it('cancelled→reenterFlow→landing（重选空 session 复活）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.cancelFlow()
      expect(flow.state.value).toBe('cancelled')
      flow.reenterFlow()
      expect(flow.state.value).toBe('landing')
    })
  })

  describe('completed 终态（T8.5）', () => {
    it('completeFlow→completed→⌘N 再 startFlow→销毁重建 idle→landing（startFlow 不 create，只 transition）', async () => {
      setGroups([gitSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
      const flow = useNewTaskFlow()
      await flow.startFlow() // 统一延迟 create：不调 create
      expect(apiMock.create).not.toHaveBeenCalled()
      flow.completeFlow() // 首条消息成功→终态
      expect(flow.state.value).toBe('completed')
      await flow.startFlow() // ⌘N 再触发→销毁重建
      expect(apiMock.create).not.toHaveBeenCalled() // startFlow 仍不 create
      expect(flow.state.value).toBe('landing')
      expect(flow.currentSessionId.value).toBeNull() // 重建后清空
    })
  })

  describe('非法转换（T8.6）', () => {
    it('idle 下直接 openBranchModal→抛错回 idle', () => {
      const flow = useNewTaskFlow()
      expect(() => flow.openBranchModal()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  describe('landing 态 branch 不可达（T4.4）', () => {
    it('landing 态 currentSession=null→gitInfo 恒 null→branch chip 隐藏 + openBranchPopover 守卫不可达', async () => {
      // 即便历史 session 是 git 目录，landing 态 currentSession=null → gitInfo 派生 null
      setGroups([
        {
          id: 'git-history',
          label: 'repo',
          cwd: '/repo',
          gitBranch: 'main',
          status: 'idle',
          lastActiveAt: 100,
          modelId: 'm',
          tokenCount: 0,
        },
      ])
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.gitInfo.value).toBeNull()
      // 状态机守卫：branch 相关动作在 landing 态不可达
      expect(() => flow.openBranchPopover()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  describe('openBranchModal 来源守卫（T6.5）', () => {
    it('非 branch-popover 来源（landing）→抛错回 idle', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow() // state=landing（非 branch-popover）
      expect(() => flow.openBranchModal()).toThrow()
      expect(flow.state.value).toBe('idle')
    })

    // 新设计下 landing→branch-popover 不可达（gitInfo null 守卫），
    // 「branch-popover 来源→正常进 branch-modal」正向用例已删（场景不可达）。
  })

  // 新设计下 landing 态 branch 链路不可达（gitInfo 恒 null），
  // 原 Esc 排队（T4.8）依赖 branch-popover 的测试已删（场景不可达）。

  /**
   * isActive 派生语义锁定：landing + 全部 overlay 态 → true（Workspace 渲染守卫依赖，
   * 延迟 create 下活跃期间 activeId=null 但须保持 Landing 挂载）；idle/completed/cancelled → false。
   * 防护：未来改状态枚举时若误把活跃态从集合移除，Workspace 守卫会静默回退到卸载 Landing，
   * 本块立刻红。
   */
  describe('isActive 派生（Workspace 渲染守卫真相源）', () => {
    it('idle → false（异常兜底态，无 session 无活跃 flow）', () => {
      const flow = useNewTaskFlow()
      expect(flow.state.value).toBe('idle')
      expect(flow.isActive.value).toBe(false)
    })

    it('landing → true（首次启动延迟 create，activeId=null 但须显示 Landing）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.state.value).toBe('landing')
      expect(flow.isActive.value).toBe(true)
    })

    it('dir-popover → true（点 directory chip 进 overlay，Landing 须保持挂载）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      expect(flow.state.value).toBe('dir-popover')
      expect(flow.isActive.value).toBe(true)
    })

    it('cancelled → false（overlay 打开时切 session，AC-3.10）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      flow.cancelFlow()
      expect(flow.state.value).toBe('cancelled')
      expect(flow.isActive.value).toBe(false)
    })

    it('cancelled → reenterFlow → landing → isActive 回 true（重选空 session 复活）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.cancelFlow()
      expect(flow.isActive.value).toBe(false)
      flow.reenterFlow()
      expect(flow.state.value).toBe('landing')
      expect(flow.isActive.value).toBe(true)
    })

    it('completed → false（首发成功终态，已绑定 activeId，由 hasSession 接管渲染）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.completeFlow()
      expect(flow.state.value).toBe('completed')
      expect(flow.isActive.value).toBe(false)
    })
  })
})
