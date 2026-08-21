/**
 * useNewTaskFlow 编排器单测（IF5）。
 *
 * 覆盖 plan TC-4..TC-8：startFlow 不变量/幂等/终态重建、submitFirstMessage 主链路
 * /bash 分支/null guard/非 landing 抛错/createInFlight 守卫/retry 迁移、closeOverlay 幂等。
 * 全部端口 mock 注入（vi.fn()）；模块级状态 beforeEach resetNewTaskFlow 隔离。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Segment, SessionSummary } from '@xyz-agent/shared'
import { resetNewTaskFlow, useNewTaskFlowState } from '../flow-state'
import { useNewTaskFlow } from '../flow'
import type { NewTaskFlowDeps } from '../ports'

/** 构造 mock 端口集（每个测试独立实例，断言 per-test） */
function makeDeps(overrides?: Partial<NewTaskFlowDeps>): NewTaskFlowDeps {
  const deps: NewTaskFlowDeps = {
    ports: {
      createSessionFlow: {
        createSession: vi.fn(),
        setThinkingLevel: vi.fn(),
      },
      chat: {
        send: vi.fn(),
        sendBash: vi.fn(),
      },
      navigation: {
        activePanelId: vi.fn(() => 'p1'),
        loadPanel: vi.fn(),
        clearActiveSession: vi.fn(),
        setActiveSession: vi.fn(),
        pushChat: vi.fn(),
        defaultCwd: vi.fn(() => '/default'),
      },
      toast: { error: vi.fn(), warning: vi.fn() },
      fileTree: { loadTree: vi.fn() },
      t: vi.fn((key: string) => key),
      migrateImage: { migrateImage: vi.fn() },
    },
    gitApi: {
      checkout: vi.fn(),
      checkoutByCwd: vi.fn(),
      createBranch: vi.fn(),
    },
    directoryPicker: { pickDirectory: vi.fn() },
    workspaceApi: {
      detect: vi.fn().mockResolvedValue({ mode: 'not-repo' }),
      listWorktrees: vi.fn().mockResolvedValue({ items: [] }),
    },
    workspaceState: {
      defaultCwd: vi.fn(() => '/default'),
      record: vi.fn(),
    },
  }
  if (overrides) {
    // 浅合并 ports 子对象（测试覆盖个别方法）
    if (overrides.ports) {
      deps.ports = { ...deps.ports, ...overrides.ports }
    }
    if (overrides.gitApi) deps.gitApi = { ...deps.gitApi, ...overrides.gitApi }
    if (overrides.directoryPicker) deps.directoryPicker = { ...deps.directoryPicker, ...overrides.directoryPicker }
    if (overrides.workspaceApi) deps.workspaceApi = { ...deps.workspaceApi, ...overrides.workspaceApi }
    if (overrides.workspaceState) deps.workspaceState = { ...deps.workspaceState, ...overrides.workspaceState }
  }
  return deps
}

const textSeg = (text: string): Segment => ({ type: 'text', text })
const imageSeg = (path: string, needsMigrate = true): Segment => ({
  type: 'image',
  id: `img-${path}`,
  path,
  fileName: 'a.png',
  displayName: 'a.png',
  needsMigrate,
})
const mockSession: SessionSummary = {
  id: 's1',
  cwd: '/tmp/x',
  modelId: 'provider/model',
  label: 'hello',
  createdAt: 0,
  updatedAt: 0,
} as SessionSummary

/** 进 landing（startFlow 是主链路前置） */
async function enterLanding(flow: ReturnType<typeof useNewTaskFlow>): Promise<void> {
  await flow.startFlow()
}

describe('useNewTaskFlow', () => {
  beforeEach(() => {
    resetNewTaskFlow()
  })

  it('TC-4: startFlow 不变量——landing 态 activeId 清空 + panel 解绑 + presetCwd 回灌', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await flow.startFlow('preset-cwd')

    expect(deps.ports.navigation.clearActiveSession).toHaveBeenCalled()
    expect(deps.ports.navigation.loadPanel).toHaveBeenCalledWith('p1', null)
    expect(useNewTaskFlowState().pendingCwd.value).toBe('preset-cwd')
    expect(useNewTaskFlowState().currentSession.value).toBeNull()
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-4b: startFlow 幂等——landing 再 startFlow 不抛、不重复翻 state', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await flow.startFlow()
    const clearCalls = (deps.ports.navigation.clearActiveSession as ReturnType<typeof vi.fn>).mock.calls.length
    await flow.startFlow() // landing→landing 非法，幂等分支不 transition
    expect(useNewTaskFlowState().state.value).toBe('landing')
    expect((deps.ports.navigation.clearActiveSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(clearCalls + 1)
  })

  it('TC-4c: startFlow completed 终态重建（transitionUnchecked 回 idle 再进 landing）', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // 直接置 completed（模拟已提交过）
    useNewTaskFlowState().state.value = 'completed' as never
    await flow.startFlow()
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-5: submitFirstMessage 主链路——create→setThinkingLevel→载入 panel→send→completed', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // mock createSessionFlow 返回 session + migratedSegments
    const migratedSegments = [textSeg('hello')]
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments,
    })

    await flow.submitFirstMessage([textSeg('hello')], 'high')

    // createSessionFlow 收 input（cwd/presetId/pendingModel/segments/bashCommand）
    expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith({
      cwd: null,
      presetId: null,
      pendingModel: null,
      segments: [textSeg('hello')],
      bashCommand: null,
      pendingThinkingLevel: 'high',
    })
    // thinkingLevel apply（C-W4-3 留壳步经端口）
    expect(deps.ports.createSessionFlow.setThinkingLevel).toHaveBeenCalledWith('s1', 'high')
    // 载入 panel + activeId + 导航 + 文件树（fire-and-forget）
    expect(deps.ports.navigation.setActiveSession).toHaveBeenCalledWith('s1')
    expect(deps.ports.navigation.loadPanel).toHaveBeenCalledWith('p1', 's1')
    expect(deps.ports.navigation.pushChat).toHaveBeenCalledWith('s1')
    expect(deps.ports.fileTree.loadTree).toHaveBeenCalledWith('s1')
    // send 用 migratedSegments
    expect(deps.ports.chat.send).toHaveBeenCalledWith('s1', migratedSegments)
    expect(deps.ports.chat.sendBash).not.toHaveBeenCalled()
    // 终态
    expect(useNewTaskFlowState().state.value).toBe('completed')
  })

  it('TC-6a: bash 分支——bashCommand 传入走 sendBash + createSessionFlow 收 bashCommand', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    const migratedSegments = [textSeg('')]
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments,
    })

    await flow.submitFirstMessage([textSeg('ls')], undefined, { command: 'ls', excludeFromContext: true })

    expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith({
      cwd: null,
      presetId: null,
      pendingModel: null,
      segments: [textSeg('ls')],
      bashCommand: { command: 'ls', excludeFromContext: true },
      pendingThinkingLevel: null,
    })
    expect(deps.ports.chat.sendBash).toHaveBeenCalledWith('s1', 'ls', true)
    expect(deps.ports.chat.send).not.toHaveBeenCalled()
    // thinkingLevel 未传 → setThinkingLevel 不调
    expect(deps.ports.createSessionFlow.setThinkingLevel).not.toHaveBeenCalled()
  })

  it('TC-6b: createSessionFlow 返回 null（空 content guard）→ abort send', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    await flow.submitFirstMessage([textSeg('hello')])

    expect(deps.ports.chat.send).not.toHaveBeenCalled()
    expect(useNewTaskFlowState().state.value).toBe('landing') // 不变
  })

  it('TC-6c: 非 landing 态 submitFirstMessage 抛错', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    // 未进 landing（state=idle）
    await expect(flow.submitFirstMessage([textSeg('hello')])).rejects.toThrow('非 landing 态')
  })

  it('TC-6d: createInFlight 守卫——飞行中重复 submitFirstMessage 幂等返回（端口零调用）', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // 模拟飞行中：直接经 controller setCreateInFlight(true)（模块级 ref）
    useNewTaskFlowController_setCreateInFlight(true)

    await flow.submitFirstMessage([textSeg('hello')])

    expect(deps.ports.createSessionFlow.createSession).not.toHaveBeenCalled()
    expect(deps.ports.chat.send).not.toHaveBeenCalled()
    useNewTaskFlowController_setCreateInFlight(false)
  })

  it('TC-7: retry 分支——session 已绑定走 migrateImage 迁移 + 部分失败 toast 不阻断', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // 绑定已有 session（重试场景）——经真实 controller 写模块级 ref（currentSession 只读视图不可直写）
    bindSession(mockSession)
    const imgSeg = imageSeg('/tmp/a.png', true)
    // 迁移成功 1 个
    ;(deps.ports.migrateImage.migrateImage as ReturnType<typeof vi.fn>).mockResolvedValue({ path: '/attachments/s1/a.png' })

    await flow.submitFirstMessage([imgSeg])

    expect(deps.ports.createSessionFlow.createSession).not.toHaveBeenCalled() // 不重复 create
    expect(deps.ports.migrateImage.migrateImage).toHaveBeenCalledWith({
      fromPath: '/tmp/a.png',
      sessionId: 's1',
      fileName: 'a.png',
    })
    // send 用迁移后的段（path 更新 + needsMigrate=false）
    expect(deps.ports.chat.send).toHaveBeenCalledWith('s1', [
      expect.objectContaining({ type: 'image', path: '/attachments/s1/a.png', needsMigrate: false }),
    ])
    // 全部迁移成功 → 无 warning toast
    expect(deps.ports.toast.warning).not.toHaveBeenCalled()
  })

  it('TC-7b: retry 分支部分迁移失败 → toastWarning + send 仍执行', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    bindSession(mockSession)
    const imgA = imageSeg('/tmp/a.png', true)
    const imgB = imageSeg('/tmp/b.png', true)
    // a 成功、b 失败
    ;(deps.ports.migrateImage.migrateImage as ReturnType<typeof vi.fn>).mockImplementation((p: { fromPath: string }) =>
      p.fromPath === '/tmp/a.png' ? Promise.resolve({ path: '/attachments/s1/a.png' }) : Promise.reject(new Error('gone')),
    )

    await flow.submitFirstMessage([imgA, imgB])

    // t 收到 key + count 参数（i18n 解析在壳侧，mock 直接返回 key）
    expect(deps.ports.t).toHaveBeenCalledWith('composable.imageMigratePartialFailed', { count: 1 })
    expect(deps.ports.toast.warning).toHaveBeenCalledTimes(1)
    // send 仍执行（b 段 path 保留原样）
    expect(deps.ports.chat.send).toHaveBeenCalledTimes(1)
  })

  it('TC-8: closeOverlay 幂等——landing 态 noop 不抛、overlay 态归 landing', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    // landing 态 closeOverlay → noop（不抛、state 不变）
    flow.closeOverlay()
    expect(useNewTaskFlowState().state.value).toBe('landing')
    // overlay 态 closeOverlay → 归 landing
    flow.openDirPopover()
    expect(useNewTaskFlowState().state.value).toBe('dir-popover')
    flow.closeOverlay()
    expect(useNewTaskFlowState().state.value).toBe('landing')
  })

  it('TC-8b: 薄转换封装——cancelFlow/reenterFlow/completeFlow', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    await enterLanding(flow)
    flow.cancelFlow()
    expect(useNewTaskFlowState().state.value).toBe('cancelled')
    flow.reenterFlow()
    expect(useNewTaskFlowState().state.value).toBe('landing')
    flow.completeFlow()
    expect(useNewTaskFlowState().state.value).toBe('completed')
  })

  it('presetCwd/setPendingModel/setPendingPreset——仅 landing 态生效', async () => {
    const deps = makeDeps()
    const flow = useNewTaskFlow(deps)
    // 非 landing（idle）→ noop
    flow.setPendingModel('p/m')
    expect(useNewTaskFlowState().pendingModel.value).toBeNull()
    await enterLanding(flow)
    flow.presetCwd('/preset')
    expect(useNewTaskFlowState().pendingCwd.value).toBe('/preset')
    flow.setPendingModel('p/m')
    expect(useNewTaskFlowState().pendingModel.value).toBe('p/m')
    flow.setPendingPreset('preset-1')
    // 通过 submitFirstMessage 的 createSessionFlow input 验证 presetId 透传
    ;(deps.ports.createSessionFlow.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
      migratedSegments: [textSeg('hello')],
    })
    await flow.submitFirstMessage([textSeg('hello')])
    expect(deps.ports.createSessionFlow.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'preset-1', cwd: '/preset', pendingModel: 'p/m' }),
    )
  })
})

/** 测试辅助：直置模块级 createInFlight ref（controller 的 setCreateInFlight 语义） */
import { useNewTaskFlowController } from '../flow-state'
function useNewTaskFlowController_setCreateInFlight(v: boolean): void {
  useNewTaskFlowController().setCreateInFlight(v)
}

/** 测试辅助：绑定 session（真实 controller 写模块级 ref） */
function bindSession(s: SessionSummary): void {
  useNewTaskFlowController().bindCurrentSession(s)
}
