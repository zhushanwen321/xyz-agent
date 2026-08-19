/**
 * W7 等价性 + 失效接线用例（data-source-governance P1.1 / P1.2 第一批）。
 *
 * 验收对照（.xyz-harness/2026-08-19-data-source-governance-p1p4/acceptance/w7-acceptance.md）：
 * - 「发 session_info_changed 后实例值最终与 get_state 一致」→ describe「真实 pi 子进程」it 1
 *   （真实 pi fixture 优先：get_state 权威源 + session_info_changed 事件均真实，markDirty 按
 *   interpreter 生产行为驱动）
 * - 「switchModel 成功后 modelId 实例 markDirty 被调」→ describe「mock RPC 层」it 1 / it 2
 * - 「session_info_changed 到达只 markDirty 不直写」→ describe「mock RPC 层」it 3 / it 4
 *   （thinking_level_changed 同构覆盖；双写回调保留断言 = 双写过渡语义）
 * - RPC 频率采样（P0.5② 首次采样）：「3 轮对话 + 1 次切模型」的实例侧 get_state 次数与
 *   p95 延迟 → describe「真实 pi 子进程」it 2（数字 console.log 输出，写进 builder 汇报；
 *   落登记表由主 agent 串行处理，本 wave 只记录不决策）
 *
 * skip-if-no-pi：真实 pi 用例以 describe.skipIf(!PI_PATH) 包裹（约定见 pi-fixture.ts 头注释）。
 * mock 层用例用 fake timers（项目规范，禁真实 sleep）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderId } from '@xyz-agent/shared'
import { EventInterpreter } from '../../services/session/event-interpreter.js'
import { SessionService } from '../../services/session/session-service.js'
import { ReplicatedState } from '../../services/session/replicated-state.js'
import {
  createLabelStateConfig,
  createThinkingLevelStateConfig,
  createModelIdStateConfig,
  SCALAR_STATE_DEBOUNCE_MS,
} from '../../services/session/replicated-states.config.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { IPiEngine, IProcessManager } from '../../services/ports/pi-engine.js'
import { spawnPiFixture, PI_PATH, type PiFixture } from './pi-fixture.js'

/** pi get_state 的宽形态 mock（三字段齐全的最小权威快照）。 */
type StateShape = Record<string, unknown>

function makeState(overrides: StateShape = {}): StateShape {
  return {
    // W7 minor 修复（W8 顺手补）：pi Model 形态 = 裸 modelId（id）+ 独立 provider 字段
    //（曾写成 id 内嵌 'provider/model' 且缺 provider——modelId 投影要求两者都是 string，
    // 缺 provider 会丢 key 走 'required' 归一，播种退避）。组合口径 'provider/model' 由投影完成。
    model: { id: 'test-model', provider: 'test-provider' },
    thinkingLevel: 'low',
    sessionName: '旧名',
    ...overrides,
  }
}

/** mock client：initializeManagedSession（getCommands）+ 实例 fetch（getState）+ switchModel（setModel）。 */
function makeClient(state: StateShape) {
  return {
    getCommands: vi.fn(async () => []),
    getState: vi.fn(async () => state),
    setModel: vi.fn(async () => undefined),
  }
}

/** 最小 SessionService 装置（参考 session-service-w07-bus.test.ts 的构造形态）。 */
function makeSessionService(client: ReturnType<typeof makeClient>): SessionService {
  const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client as unknown as IPiEngine),
  } as unknown as IProcessManager
  return new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
  )
}

describe('W7 scalar-state 失效接线（mock RPC 层）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('switchModel 成功响应后 modelId 实例 markDirty 被调（且只调一次）', async () => {
    const client = makeClient(makeState())
    const svc = makeSessionService(client)
    await svc.initializeManagedSession('s-switch', client as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1) // flush 三实例播种 refetch

    const states = svc.getScalarReplicatedStates('s-switch')
    expect(states).toBeDefined()
    const markDirtySpy = vi.spyOn(states!.modelId, 'markDirty')

    // mock 场景品牌类型无运行时语义，显式收窄到 ProviderId
    const provider = 'test-provider' as ProviderId
    await svc.switchModel('s-switch', provider, 'new-model')
    expect(client.setModel).toHaveBeenCalledWith('test-provider', 'new-model')
    expect(markDirtySpy).toHaveBeenCalledTimes(1)
  })

  it('switchModel RPC 失败（throw）不失效 modelId 实例——pi 侧未生效，实例保持旧快照', async () => {
    const client = makeClient(makeState())
    client.setModel.mockRejectedValue(new Error('rpc down'))
    const svc = makeSessionService(client)
    await svc.initializeManagedSession('s-fail', client as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1)

    const states = svc.getScalarReplicatedStates('s-fail')!
    const markDirtySpy = vi.spyOn(states.modelId, 'markDirty')

    const provider = 'test-provider' as ProviderId
    await expect(svc.switchModel('s-fail', provider, 'new-model')).rejects.toThrow('rpc down')
    expect(markDirtySpy).not.toHaveBeenCalled()
  })

  it('session_info_changed 到达只 markDirty 不直写：立即读为旧快照，防抖到点后快照来自 get_state（非事件 payload）', async () => {
    const fetchState = vi.fn(async () => makeState({ sessionName: '旧名' }))
    const labelState = new ReplicatedState(createLabelStateConfig(fetchState))
    labelState.refetch()
    await vi.advanceTimersByTimeAsync(1)
    expect(labelState.get()).toEqual({ sessionName: '旧名' }) // 播种完成

    // 权威源已变更（get_state 将返回新名）；事件 payload 是第三个值（证明数据来自快照而非事件）
    fetchState.mockResolvedValue(makeState({ sessionName: '权威新名' }))
    const markDirtySpy = vi.spyOn(labelState, 'markDirty')
    const onSessionRenamed = vi.fn() // 组合根接 setLabelCache（W12 前列表 label 即时数据源）

    const interpreter = new EventInterpreter('s-label', {
      send: vi.fn(),
      labelState: () => labelState,
      onSessionRenamed,
    })
    interpreter.interpret([{ kind: 'session-renamed', name: '事件payload名' }])

    // 事件唯一动作 = 失效；实例数据未被直写（立即读 = 旧快照）
    expect(markDirtySpy).toHaveBeenCalledTimes(1)
    expect(labelState.get()).toEqual({ sessionName: '旧名' })
    // 内存态回写回调照常触发（session.label 即时数据源，W12/W13 后退役）
    expect(onSessionRenamed).toHaveBeenCalledWith('s-label', '事件payload名')

    // 防抖到点 → 唯一写路径 get_state 快照；值是权威新名而非事件 payload 名
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    expect(labelState.get()).toEqual({ sessionName: '权威新名' })
    expect(labelState.isDirty()).toBe(false)
    labelState.dispose()
  })

  it('thinking_level_changed 到达只 markDirty 不直写（同构覆盖第二事件）', async () => {
    const fetchState = vi.fn(async () => makeState({ thinkingLevel: 'low' }))
    const thinkingLevelState = new ReplicatedState(createThinkingLevelStateConfig(fetchState))
    thinkingLevelState.refetch()
    await vi.advanceTimersByTimeAsync(1)
    expect(thinkingLevelState.get()).toEqual({ thinkingLevel: 'low' })

    fetchState.mockResolvedValue(makeState({ thinkingLevel: 'high' }))
    const markDirtySpy = vi.spyOn(thinkingLevelState, 'markDirty')

    // W9：onThinkingLevelChanged 旧缓存回写回调已删——事件唯一动作是失效，无任何直写。
    const interpreter = new EventInterpreter('s-tl', {
      send: vi.fn(),
      thinkingLevelState: () => thinkingLevelState,
    })
    interpreter.interpret([{ kind: 'thinking-level', level: '事件payload档位' }])

    expect(markDirtySpy).toHaveBeenCalledTimes(1)
    expect(thinkingLevelState.get()).toEqual({ thinkingLevel: 'low' }) // 不直写

    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    expect(thinkingLevelState.get()).toEqual({ thinkingLevel: 'high' }) // 快照来自 get_state
    thinkingLevelState.dispose()
  })
})

/** 真实 timers 轮询等待（真实 pi 用例；fake timers 禁用于真实子进程 IO）。 */
async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${label}`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 等 turn 完成的上限（真实 LLM 调用；对齐 live-reload.test.ts 的余量口径） */
const TURN_TIMEOUT_MS = 120_000

describe.skipIf(!PI_PATH)('W7 equivalence: 标量实例失效收敛（真实 pi 子进程）', () => {
  let fixture: PiFixture | null = null

  afterEach(async () => {
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  it('set_session_name → session_info_changed → markDirty → label 实例快照最终与 get_state 一致', { timeout: 60_000 }, async () => {
    const fx = await spawnPiFixture()
    fixture = fx

    const fetchState = async (): Promise<StateShape> => {
      const resp = await fx.sendCommand('get_state')
      return (resp.data ?? {}) as StateShape
    }
    const labelState = new ReplicatedState(createLabelStateConfig(fetchState))
    const modelIdState = new ReplicatedState(createModelIdStateConfig(fetchState))

    // 播种首份快照（生产：registerReplicatedStates 的 refetch）
    labelState.refetch()
    modelIdState.refetch()
    await waitUntil('seed snapshots', () => labelState.get() !== undefined && modelIdState.get() !== undefined)

    // 播种一致性：modelId 快照 == get_state().model 组合的 'provider/model'
    //（pi Model.id 是裸 modelId，provider 在 Model.provider——投影组合口径）
    const seedState = await fetchState()
    const seedModel = seedState.model as { provider?: unknown; id?: unknown } | undefined
    const seedModelId =
      typeof seedModel?.provider === 'string' && typeof seedModel?.id === 'string'
        ? `${seedModel.provider}/${seedModel.id}`
        : undefined
    expect(seedModelId).toBeTruthy()
    expect(modelIdState.get()).toEqual({ modelId: seedModelId })

    // pi 侧改名 → 等 session_info_changed 事件（事件真实性）
    await fx.sendCommand('set_session_name', { name: 'equiv-w7-label' })
    await fx.waitForEvent((e) => e.type === 'session_info_changed')

    // interpreter 生产行为：事件到达 → 唯一动作 markDirty
    const before = labelState.get()
    labelState.markDirty()
    // 同步时刻读 = 旧快照（事件未直写；真实 timers 下防抖窗口 300ms 内）
    expect(labelState.get()).toBe(before)

    // 防抖 + get_state → 收敛（isDirty 清除 = 成功快照应用且无新失效）
    await waitUntil('label converge after rename', () => !labelState.isDirty())
    expect(labelState.get()).toEqual({ sessionName: 'equiv-w7-label' })

    // 终态等价断言：实例快照 == 此刻权威 get_state 投影（防 0==0 空转：值是确定非空名）
    const authoritative = await fetchState()
    expect(authoritative.sessionName).toBe('equiv-w7-label')
    expect(labelState.get()).toEqual({ sessionName: authoritative.sessionName as string | undefined })

    // 第二次改名强化收敛链路（非首次播种巧合）
    await fx.sendCommand('set_session_name', { name: 'equiv-w7-label-2' })
    await fx.waitForEvent(
      (e) => e.type === 'session_info_changed' && e.name === 'equiv-w7-label-2',
    )
    labelState.markDirty()
    await waitUntil('label converge after second rename', () => labelState.get()?.sessionName === 'equiv-w7-label-2')

    labelState.dispose()
    modelIdState.dispose()
  })

  it('RPC 频率采样（P0.5②）：3 轮对话 + 1 次切模型的实例侧 get_state 次数与 p95 延迟', { timeout: 180_000 }, async () => {
    const fx = await spawnPiFixture()
    fixture = fx

    // 包装 fetchState：统计次数 + 逐次延迟（ms）
    const latencies: number[] = []
    let calls = 0
    const fetchState = async (): Promise<StateShape> => {
      calls += 1
      const t0 = performance.now()
      const resp = await fx.sendCommand('get_state')
      latencies.push(performance.now() - t0)
      return (resp.data ?? {}) as StateShape
    }
    const labelState = new ReplicatedState(createLabelStateConfig(fetchState))
    const thinkingLevelState = new ReplicatedState(createThinkingLevelStateConfig(fetchState))
    const modelIdState = new ReplicatedState(createModelIdStateConfig(fetchState))

    // 生产等价：注册播种（3 refetch）
    const states = [labelState, thinkingLevelState, modelIdState]
    for (const s of states) s.refetch()
    await waitUntil('seed', () => states.every((s) => s.get() !== undefined))
    const seededCalls = calls

    // 3 轮对话：每轮等「新的」agent_end（按计数递增等待，禁 waitForEvent——它匹配历史
    // 事件缓存会立即返回，下一轮 prompt 撞 pi already-processing）；期间到达的
    // session_info_changed / thinking_level_changed 按生产接线喂给对应实例 markDirty
    // （interpreter 生产行为），并等防抖拉取收敛
    for (let i = 0; i < 3; i++) {
      const round = i + 1
      const agentEndBefore = fx.collectEvents((e) => e.type === 'agent_end').length
      const infoBefore = fx.collectEvents((e) => e.type === 'session_info_changed').length
      const tlBefore = fx.collectEvents((e) => e.type === 'thinking_level_changed').length
      await fx.sendCommand('prompt', { message: `Reply with exactly: round-${round}` })
      await waitUntil(
        `round-${round} agent_end`,
        () => fx.collectEvents((e) => e.type === 'agent_end').length > agentEndBefore,
        TURN_TIMEOUT_MS,
      )
      if (fx.collectEvents((e) => e.type === 'session_info_changed').length > infoBefore) {
        labelState.markDirty()
        await waitUntil(`round-${round} label converge`, () => !labelState.isDirty())
      }
      if (fx.collectEvents((e) => e.type === 'thinking_level_changed').length > tlBefore) {
        thinkingLevelState.markDirty()
        await waitUntil(`round-${round} thinkingLevel converge`, () => !thinkingLevelState.isDirty())
      }
    }

    // 1 次切模型（set_model 成功响应 → modelId markDirty，生产接线）。
    // pi set_model 参数 = 裸 provider + 裸 modelId（Model.id，非 'provider/model' 组合）
    const modelResp = await fx.sendCommand('get_state')
    const currentModel = modelResp.data?.model as { provider?: string; id?: string } | undefined
    expect(currentModel?.provider).toBeTruthy()
    expect(currentModel?.id).toBeTruthy()
    await fx.sendCommand('set_model', { provider: currentModel!.provider, modelId: currentModel!.id })
    modelIdState.markDirty()
    await waitUntil('modelId converge', () => !modelIdState.isDirty())

    // nearest-rank p95（1-indexed 第 ceil(0.95n) 位）
    const sorted = [...latencies].sort((a, b) => a - b)
    const rank = Math.max(1, Math.ceil(sorted.length * 0.95))
    const p95 = sorted[rank - 1] as number
    // 采样数字（写进 builder 汇报；落登记表由主 agent 串行处理——本 wave 只记录不决策）
    console.log(
      `[W7 RPC 采样] 操作序列 = 3 轮对话 + 1 次切模型 | get_state 总次数 = ${calls}` +
      `（播种 ${seededCalls} + 失效驱动 ${calls - seededCalls}）| p95 延迟 = ${p95.toFixed(1)}ms` +
      `（n=${latencies.length}，max=${(sorted[sorted.length - 1] as number).toFixed(1)}ms）`,
    )
    expect(calls).toBeGreaterThan(0)
    expect(latencies.length).toBe(calls)

    for (const s of states) s.dispose()
  })
})
