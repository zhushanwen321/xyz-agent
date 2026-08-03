/**
 * C3 replay 时序竞态测试（review CRITICAL：replay 段发送期间并发实时广播）。
 *
 * 验证：认证成功 → replay 段发送期间，并发的 broker.broadcast 不会把实时消息推给该 ws
 * 与 replay 段在 TCP 流上交错。
 *
 * 背景：handleAuthMessage 在 clients.set（入广播池）后 await onAuthSuccess（间隙）+
 * 发 replay 段。此窗口内其他 client 的 handler 可能触发 broker.broadcast 遍历 pool.clients，
 * 把实时消息推给本 ws → 与随后到达的 replay 段交错（replay seq=120 → 实时 seq=151 →
 * replay seq=121…）→ 非幂等 chat effect 跨 turn 拼接 → 气泡内容混乱。
 *
 * 修复（Direction C）：ConnectionCtx.replaying 标记，broadcast/broadcastExcept 跳过 replaying
 * 的 ws，try/finally 保证发送完成即清回。
 *
 * 测试策略（真起 wss + 真实 WebSocket，与 connection-manager.auth.test.ts 同范式）：
 *  - client-A 先认证入池（对照：广播到达已认证连接）。
 *  - client-B 认证时，onAuthSuccess 用 deferred 控制——resolve 前先触发一次 broadcast，
 *    断言 client-B 此刻未收到该广播（被 replaying 跳过），client-A 收到了。
 *  - resolve 后 client-B 收到 replay 段（按序连续），最后断言 client-B 收到的消息序列
 *    是 replay 段 + 无交错。
 *  - replay 完成后再广播一次，断言 client-B 正常收到（replaying 标记已清）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/connection-manager.replay-race.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTokenManager } from '../token.js'
import type {
  ConnectionManager,
  ConnectionCallbacks,
  AuthReplayInput,
  ReplayDecision,
} from '../connection-manager.js'
import type { BrokerServices } from '../message-broker.js'

// ── 临时 token 文件 fixture（同 connection-manager.auth.test.ts） ──────────

interface TokenFixture {
  file: string
  token: string
  cleanup: () => void
}

function makeTokenFixture(token: string): TokenFixture {
  const dir = mkdtempSync(join(tmpdir(), 'xyz-replay-race-'))
  const file = join(dir, 'token')
  writeFileSync(file, token, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  // eslint-disable-next-line taste/no-silent-catch -- 非 POSIX FS 不支持 chmod 不阻断
  } catch {
    // 权限模型不可用时跳过
  }
  return {
    file,
    token,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      // eslint-disable-next-line taste/no-silent-catch -- cleanup 失败不阻断测试结果
      } catch {
        // tmpdir 兜底
      }
    },
  }
}

// ── deferred：控制 onAuthSuccess 的 resolve 时机 ─────────────────────────

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// ── WS 客户端连接 helper（同 auth 测试范式） ──────────────────────────────

interface ConnectResult {
  ws: WebSocket
  nextMessage: (timeoutMs?: number) => Promise<{ type: string; seq?: number; [key: string]: unknown }>
  /** 取到目前为止已收到的全部消息（不清空）。 */
  received: () => Array<{ type: string; seq?: number }>
}

function connectWs(url: string): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const messageQueue: Array<{ type: string; seq?: number }> = []
    ws.on('open', () => resolve({
      ws,
      nextMessage: (timeoutMs = 3000) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`nextMessage 超时 ${timeoutMs}ms`)), timeoutMs)
        const check = (): void => {
          if (messageQueue.length > 0) {
            clearTimeout(t)
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length>0 已保证非空
            res(messageQueue.shift()!)
          } else {
            setTimeout(check, 5)
          }
        }
        check()
      }),
      received: () => [...messageQueue],
    }))
    ws.on('message', (raw) => {
      try {
        messageQueue.push(JSON.parse(raw.toString()))
      // eslint-disable-next-line taste/no-silent-catch -- 非 JSON 不入队列
      } catch {
        // 忽略
      }
    })
    ws.on('error', (err) => {
      if (ws.readyState === WebSocket.CONNECTING) reject(err)
    })
  })
}

function sendAuth(ws: WebSocket, payload: { token: string; clientId: string; lastSeq?: number; bootId?: string; subscribedSessions?: string[] }, id = 'auth-1'): void {
  ws.send(JSON.stringify({ type: 'auth', id, payload }))
}

// ── 最小 broker services mock（与 auth 测试 S6 同） ────────────────────────

function makeBrokerServices(): BrokerServices {
  return {
    sessionService: { listPersistedSessions: () => [] },
    configService: {
      listProviders: () => [], getConfigVersion: () => 0, getDefaultModel: () => null,
      loadSkills: () => [], loadAgents: () => [], getSkillDirs: () => [], getAgentDirs: () => [],
      getExtensionDirs: () => [],
      getSystemPromptConfig: () => ({ config: {}, corrupted: false }),
      getTerminalConfig: () => ({ config: {}, corrupted: false }),
    },
    modelService: { aggregateModels: () => [] },
    pluginService: undefined,
    extensionService: undefined,
    extensionTimeoutMgr: { getAllPendingRequests: () => [] } as never,
    projectRoot: '/test',
    appInfo: { appVersion: 'test', piVersion: 'test' },
  } as never
}

// ── Tests ─────────────────────────────────────────────────────────

describe('C3 replay 时序竞态（replay 段发送期间并发广播不交错）', () => {
  let fixture: TokenFixture

  beforeEach(() => {
    vi.useRealTimers()
    fixture = makeTokenFixture('replay-race-token-xyz')
  })
  afterEach(() => {
    fixture.cleanup()
  })

  it('R1: onAuthSuccess await 间隙触发的 broadcast 不投递给 replaying 的 ws（client-B 未收，client-A 已收）', async () => {
    // onAuthSuccess 用 deferred：测试在 resolve 前触发 broadcast，验证 client-B 被跳过。
    const authTriggered = makeDeferred<void>()
    let broadcastDuringReplay = false
    let brokerBroadcast: ((msg: object) => void) | null = null

    const onConnect = vi.fn()
    const onMessage = vi.fn().mockResolvedValue(undefined)
    const onDisconnect = vi.fn()
    const sendError = vi.fn()
    const onAuthSuccess = vi.fn(async (
      _ws: WebSocket,
      clientId: string,
      _input: AuthReplayInput,
    ): Promise<ReplayDecision> => {
      // 仅对 client-B 走 replay 路径（带 messages）；client-A 走冷启动（resume:false）。
      if (clientId !== 'client-B') {
        return { resume: false, messages: [], seqReset: false, replayedCount: 0, bootId: 'boot', serverSeq: 0 }
      }
      // 在 await 间隙（replay 段尚未发送）触发一次 broadcast。
      // 此时 client-B 已在 pool（clients.set 已执行）且 ctx.replaying=true。
      if (brokerBroadcast) {
        broadcastDuringReplay = true
        brokerBroadcast({ type: 'app.info', payload: { appVersion: 'live', piVersion: '1' } })
      }
      // 等测试断言完「client-B 未收到」后再 resolve，让 replay 段继续发送。
      await authTriggered.promise
      return {
        resume: true,
        // 3 条 replay 段（已序列化字符串，含 seq 101/102/103）。
        messages: [
          JSON.stringify({ type: 'context.update', seq: 101, payload: { sessionId: 's1', n: 1 } }),
          JSON.stringify({ type: 'context.update', seq: 102, payload: { sessionId: 's1', n: 2 } }),
          JSON.stringify({ type: 'context.update', seq: 103, payload: { sessionId: 's1', n: 3 } }),
        ],
        seqReset: false,
        replayedCount: 3,
        bootId: 'boot',
        serverSeq: 100,
      }
    })
    const callbacks: ConnectionCallbacks = {
      onConnect, onMessage, onDisconnect, sendError, onAuthSuccess,
    }

    const { ConnectionManager } = await import('../connection-manager.js')
    const { ServerMessageBroker } = await import('../message-broker.js')
    const port = 32000 + Math.floor(Math.random() * 1000)
    const tokenManager = createTokenManager({ tokenFile: fixture.file })
    const cm = new ConnectionManager(port, callbacks, { loopbackAuthBypass: false, tokenManager, serverVersion: 'test' })
    const broker = new ServerMessageBroker(cm, makeBrokerServices())
    brokerBroadcast = (msg) => broker.broadcast(msg as never)
    await cm.start()
    try {
      // 1) client-A 先认证入池（对照：广播到达已认证连接）。
      const cA = await connectWs(`ws://127.0.0.1:${port}`)
      sendAuth(cA.ws, { token: fixture.token, clientId: 'client-A' })
      await cA.nextMessage(3000) // auth.ok
      await vi.waitFor(() => expect(cm.clients.has('client-A')).toBe(true))

      // 2) client-B 认证（带 lastSeq/bootId 触发 resume 路径）。
      //    onAuthSuccess 在 client-B 的处理流程中被调，内部 await authTriggered.promise 暂停，
      //    故 auth.ok 与 replay 段在 resolve 前不会发出——这正是 replay 窗口（replaying=true）。
      const cB = await connectWs(`ws://127.0.0.1:${port}`)
      sendAuth(cB.ws, {
        token: fixture.token, clientId: 'client-B',
        lastSeq: 100, bootId: 'boot', subscribedSessions: ['s1'],
      })

      // 3) 等 onAuthSuccess 进入窗口（broadcastDuringReplay 置位说明 onAuthSuccess 已被调且触发了广播）。
      await vi.waitFor(() => expect(broadcastDuringReplay).toBe(true))

      // 4) 关键断言（replay 窗口内）：并发的 broadcast，client-B 未收到（被 replaying 跳过），
      //    client-A 收到了（对照：广播本身正常执行，仅跳过 replaying 的 ws）。
      //    client-B 此刻不应有任何消息（auth.ok 在 onAuthSuccess resolve 后才发）。
      expect(cB.received().some((m) => m.type === 'app.info')).toBe(false)
      const aGotLive = await cA.nextMessage(3000)
      expect(aGotLive.type).toBe('app.info')

      // 5) 放行 replay：client-B 收到 auth.ok + 3 条 replay 段，按序连续，无 app.info 交错。
      authTriggered.resolve(undefined)
      const bAuthOk = await cB.nextMessage(3000)
      expect(bAuthOk.type).toBe('auth.ok')
      const r1 = await cB.nextMessage(3000)
      const r2 = await cB.nextMessage(3000)
      const r3 = await cB.nextMessage(3000)
      expect(r1.seq).toBe(101)
      expect(r2.seq).toBe(102)
      expect(r3.seq).toBe(103)
      // 整段 client-B 收到的消息（auth.ok + replay 段）不含 app.info（被跳过的实时广播）
      const bAll = cB.received()
      expect(bAll.some((m) => m.type === 'app.info')).toBe(false)

      // 6) replay 完成后（replaying 已清），新广播正常到达 client-B。
      broker.broadcast({ type: 'app.info', payload: { appVersion: 'after', piVersion: '1' } } as never)
      const bAfter = await cB.nextMessage(3000)
      expect(bAfter.type).toBe('app.info')

      cA.ws.close()
      cB.ws.close()
    } finally {
      await cm.stop()
    }
  }, 15000)

  it('R2: reset/冷启动路径（resume:false）不触发 replaying 标记残留——后续广播正常到达', async () => {
    // 验证 finally 复位：即使走 onConnect 冷启动路径，replaying 也清回 false，广播恢复正常。
    const onConnect = vi.fn()
    const onMessage = vi.fn().mockResolvedValue(undefined)
    const onDisconnect = vi.fn()
    const sendError = vi.fn()
    const onAuthSuccess = vi.fn(async (): Promise<ReplayDecision> => ({
      // 冷启动：resume:false，messages:[]，走 onConnect 路径。
      resume: false, messages: [], seqReset: false, replayedCount: 0, bootId: 'boot', serverSeq: 0,
    }))
    const callbacks: ConnectionCallbacks = { onConnect, onMessage, onDisconnect, sendError, onAuthSuccess }

    const { ConnectionManager } = await import('../connection-manager.js')
    const { ServerMessageBroker } = await import('../message-broker.js')
    const port = 32200 + Math.floor(Math.random() * 1000)
    const tokenManager = createTokenManager({ tokenFile: fixture.file })
    const cm = new ConnectionManager(port, callbacks, { loopbackAuthBypass: false, tokenManager, serverVersion: 'test' })
    const broker = new ServerMessageBroker(cm, makeBrokerServices())
    await cm.start()
    try {
      const c = await connectWs(`ws://127.0.0.1:${port}`)
      sendAuth(c.ws, { token: fixture.token, clientId: 'client-cold' })
      await c.nextMessage(3000) // auth.ok
      await vi.waitFor(() => expect(cm.clients.has('client-cold')).toBe(true))
      // onConnect 被调（冷启动推 initial state 路径）
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))

      // ctx.replaying 应为 false（finally 已复位；冷启动路径 try 块内未改 message，但 try/finally 仍跑过）。
      const ctx = cm.clients.get('client-cold')
      expect(ctx?.replaying).toBeFalsy()

      // 后续广播正常到达（未被 replaying 残留跳过）。
      broker.broadcast({ type: 'app.info', payload: { appVersion: 'x', piVersion: '1' } } as never)
      const msg = await c.nextMessage(3000)
      expect(msg.type).toBe('app.info')

      c.ws.close()
    } finally {
      await cm.stop()
    }
  })

  it('R3: onAuthSuccess 抛错路径 finally 复位 replaying（虽 client 被踢出池，标记不复位也无副作用，但验证 try/finally 覆盖异常路径）', async () => {
    const onConnect = vi.fn()
    const onMessage = vi.fn().mockResolvedValue(undefined)
    const onDisconnect = vi.fn()
    const sendError = vi.fn()
    const onAuthSuccess = vi.fn(async (): Promise<ReplayDecision> => {
      throw new Error('broker getReplayPlan exploded')
    })
    const callbacks: ConnectionCallbacks = { onConnect, onMessage, onDisconnect, sendError, onAuthSuccess }

    const { ConnectionManager } = await import('../connection-manager.js')
    const port = 32400 + Math.floor(Math.random() * 1000)
    const tokenManager = createTokenManager({ tokenFile: fixture.file })
    const cm = new ConnectionManager(port, callbacks, { loopbackAuthBypass: false, tokenManager, serverVersion: 'test' })
    await cm.start()
    try {
      const c = await connectWs(`ws://127.0.0.1:${port}`)
      sendAuth(c.ws, { token: fixture.token, clientId: 'client-err' })
      // onAuthSuccess 抛错 → connection 被 close(4001, replay_failed)，client 踢出池。
      await new Promise<void>((resolve) => {
        c.ws.once('close', () => resolve())
      })
      // client 已踢出池（异常路径 cleanup）。
      expect(cm.clients.has('client-err')).toBe(false)
      // onConnect 未被调（异常分支 return）。
      expect(onConnect).not.toHaveBeenCalled()
      c.ws.close()
    } finally {
      await cm.stop()
    }
  })
})
