/**
 * RuntimeServer onAuthSuccess 注入测试（P2-s2-w2 / TC-W2.1~W2.5）。
 *
 * 覆盖 5 个 testCases：
 * - TC-W2.1: broker.getSeq 暴露当前 seq（只读 getter，不推进）
 * - TC-W2.2: 冷启动（无 lastSeq/bootId）→ ReplayDecision{resume:false, seqReset:false}，不调 getReplayPlan
 * - TC-W2.3: resume 路径（lastSeq/bootId 有效 + broker 返回 resume）→ messages + replayedCount
 * - TC-W2.4: reset 路径（broker 返回 reset）→ seqReset:true，messages:[]
 * - TC-W2.5: lastSeq 有值但 bootId 缺失 → 冷启动（ES5 防御）
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/server.onauthsuccess.test.ts
 *
 * 测试策略：直接构造 RuntimeServer，注入 mock broker（getReplayPlan/getBootId/getSeq 可控），
 * 经 (server as unknown as {handleAuthReplay}).handleAuthReplay(input) 触发私有方法，断言 ReplayDecision。
 * 避免启动完整 WS 服务器 + setServices 装配（重 mock）。
 */
import { describe, it, expect, vi } from 'vitest'
import type { AuthReplayInput, ReplayDecision } from '../connection-manager.js'

// ── Mock broker（只暴露 handleAuthReplay 依赖的 3 方法） ────────────────

interface MockBroker {
  getBootId: () => string
  getSeq: () => number
  getReplayPlan: (lastSeq: number, bootId: string, subscribedSessions: string[]) =>
    { kind: 'resume'; messages: string[] } | { kind: 'reset' }
}

function makeMockBroker(opts: Partial<MockBroker> = {}): MockBroker {
  return {
    getBootId: opts.getBootId ?? (() => 'boot-xyz'),
    getSeq: opts.getSeq ?? (() => 0),
    getReplayPlan: opts.getReplayPlan ?? (() => ({ kind: 'resume', messages: [] })),
  }
}

/** 构造 RuntimeServer 并注入 mock broker（绕过完整 setServices 装配）。 */
async function makeServerWithBroker(broker: MockBroker): Promise<{ server: { handleAuthReplay(input: AuthReplayInput): Promise<ReplayDecision> }; broker: MockBroker }> {
  const { RuntimeServer } = await import('../server.js')
  const server = new RuntimeServer(0, '/mock-root') as unknown as { broker: MockBroker; handleAuthReplay(input: AuthReplayInput): Promise<ReplayDecision> }
  // 直接覆写 broker（绕过 setServices 的复杂装配——handleAuthReplay 只读 3 方法）
  server.broker = broker
  return { server, broker }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('RuntimeServer onAuthSuccess injection (P2-s2-w2)', () => {
  // ── TC-W2.1: broker.getSeq 暴露当前 seq ─────────────────────────

  it('TC-W2.1: broker.getSeq 返回当前已分配的最大 seq（只读，不推进）', async () => {
    const { ServerMessageBroker } = await import('../message-broker.js')
    const ws = { readyState: 1, send: () => {} } // broker 不需真实 ws（getSeq 不涉及 send）
    const broker = new ServerMessageBroker(
      { clients: new Map() },
      {
        sessionService: { listPersistedSessions: () => [] },
        configService: { listProviders: () => [], getDefaultModel: () => null, loadSkills: () => [], loadAgents: () => [], getSkillDirs: () => [], getAgentDirs: () => [], getExtensionDirs: () => [], getSystemPromptConfig: () => ({ config: {}, corrupted: false }), getTerminalConfig: () => ({ config: {}, corrupted: false }) },
        modelService: { aggregateModels: () => [] },
        pluginService: undefined,
        extensionService: undefined,
        projectRoot: '/m',
        appInfo: { appVersion: '0', piVersion: '0' },
      } as never,
    )
    // 初始 seq=0（未广播过）
    expect(broker.getSeq()).toBe(0)
    // 广播后 seq 推进
    broker.broadcast({ type: 'app.info', payload: { appVersion: '1', piVersion: '1' } } as never)
    expect(broker.getSeq()).toBe(1)
    broker.broadcast({ type: 'app.info', payload: { appVersion: '1', piVersion: '1' } } as never)
    expect(broker.getSeq()).toBe(2)
    // getSeq 不推进（连续调用返回同值）
    expect(broker.getSeq()).toBe(2)
    void ws
  })

  // ── TC-W2.2: 冷启动（无 lastSeq/bootId）→ resume:false, seqReset:false ─

  it('TC-W2.2: 冷启动（lastSeq undefined）→ ReplayDecision{resume:false, seqReset:false}，不调 getReplayPlan', async () => {
    const getReplayPlan = vi.fn()
    const broker = makeMockBroker({
      getBootId: () => 'boot-123',
      getSeq: () => 5,
      getReplayPlan: getReplayPlan as never,
    })
    const { server } = await makeServerWithBroker(broker)

    const decision = await server.handleAuthReplay({ lastSeq: undefined, bootId: undefined, subscribedSessions: [] })

    expect(decision).toEqual({
      resume: false,
      messages: [],
      seqReset: false,
      replayedCount: 0,
      bootId: 'boot-123',
      serverSeq: 5,
    })
    // 冷启动不调 getReplayPlan（无重连凭据，回放无意义）
    expect(getReplayPlan).not.toHaveBeenCalled()
  })

  // ── TC-W2.3: resume 路径 → messages + replayedCount ────────────────

  it('TC-W2.3: resume 路径（broker 返回 resume + messages）→ ReplayDecision.resume=true, messages 透传, replayedCount 正确', async () => {
    const getReplayPlan = vi.fn(() => ({ kind: 'resume' as const, messages: ['msg-6', 'msg-7', 'msg-8'] }))
    const broker = makeMockBroker({
      getBootId: () => 'boot-456',
      getSeq: () => 10,
      getReplayPlan,
    })
    const { server } = await makeServerWithBroker(broker)

    const decision = await server.handleAuthReplay({ lastSeq: 5, bootId: 'boot-456', subscribedSessions: ['sA'] })

    expect(decision).toEqual({
      resume: true,
      messages: ['msg-6', 'msg-7', 'msg-8'],
      seqReset: false,
      replayedCount: 3,
      bootId: 'boot-456',
      serverSeq: 10,
    })
    // getReplayPlan 被调用，入参透传
    expect(getReplayPlan).toHaveBeenCalledWith(5, 'boot-456', ['sA'])
  })

  // ── TC-W2.4: reset 路径 → seqReset:true, messages:[] ────────────────

  it('TC-W2.4: reset 路径（broker 返回 reset）→ ReplayDecision{resume:false, seqReset:true, messages:[]}', async () => {
    const broker = makeMockBroker({
      getBootId: () => 'boot-789',
      getSeq: () => 20,
      getReplayPlan: () => ({ kind: 'reset' }),
    })
    const { server } = await makeServerWithBroker(broker)

    const decision = await server.handleAuthReplay({ lastSeq: 1, bootId: 'stale-boot', subscribedSessions: ['sA'] })

    expect(decision).toEqual({
      resume: false,
      messages: [],
      seqReset: true,
      replayedCount: 0,
      bootId: 'boot-789',
      serverSeq: 20,
    })
  })

  // ── TC-W2.5: lastSeq 有值但 bootId 缺失 → 冷启动（ES5） ───────────

  it('TC-W2.5: lastSeq 有值但 bootId 缺失 → 冷启动（ES5 防御，不调 getReplayPlan）', async () => {
    const getReplayPlan = vi.fn()
    const broker = makeMockBroker({
      getBootId: () => 'boot-real',
      getSeq: () => 3,
      getReplayPlan: getReplayPlan as never,
    })
    const { server } = await makeServerWithBroker(broker)

    // lastSeq=5 有值但 bootId=undefined（客户端协议漂移：lastSeq 与 bootId 应成对）
    const decision = await server.handleAuthReplay({ lastSeq: 5, bootId: undefined, subscribedSessions: ['sA'] })

    // 走冷启动路径（resume:false, seqReset:false），不调 getReplayPlan
    expect(decision.resume).toBe(false)
    expect(decision.seqReset).toBe(false)
    expect(getReplayPlan).not.toHaveBeenCalled()
    expect(decision.bootId).toBe('boot-real')
    expect(decision.serverSeq).toBe(3)
  })

  // ── 补强：bootId 有值但 lastSeq 缺失 → 冷启动（对称 ES5） ─────────

  it('TC-W2.5b: bootId 有值但 lastSeq 缺失 → 冷启动（对称防御）', async () => {
    const getReplayPlan = vi.fn()
    const broker = makeMockBroker({
      getBootId: () => 'boot-real',
      getSeq: () => 7,
      getReplayPlan: getReplayPlan as never,
    })
    const { server } = await makeServerWithBroker(broker)

    const decision = await server.handleAuthReplay({ lastSeq: undefined, bootId: 'boot-real', subscribedSessions: [] })

    expect(decision.resume).toBe(false)
    expect(decision.seqReset).toBe(false)
    expect(getReplayPlan).not.toHaveBeenCalled()
  })
})
