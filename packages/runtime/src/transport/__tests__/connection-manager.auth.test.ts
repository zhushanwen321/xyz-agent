/**
 * ConnectionManager 认证门单测（spec §十三 测试计划 #1）。
 *
 * 覆盖 spec 要求的 7 个场景（mock ws：token 对/错/超时/首消息非 auth/
 * 同 clientId 挤占/未认证不进广播池/未认证上限）：
 *  - S1 token 对：合法 auth → auth.ok + onConnect + 入正式池（authenticated 态）
 *  - S2 token 错：错误 token → close(4001, 'unauthorized')
 *  - S3 超时（auth_timeout）：连接后不发 auth → 超时 close(4001, 'auth_timeout')
 *  - S4 首消息非 auth：首条消息 type !== 'auth' → close(4001, 'auth_required')
 *  - S5 同 clientId 挤占（kick）：新连接用已存在 clientId → 旧连接 close(4002, 'replaced')
 *  - S6 未认证不进广播池：未完成 auth 的连接不接收 broadcast（broker.broadcast 不投递）
 *  - S7 未认证上限（MAX_PENDING/server_busy）：pending 满 → 新连接立即 close(4001, 'server_busy')
 *
 * 测试策略：与 connection-manager.lease.test.ts 一致——真起 wss（自由端口）+ 真实 WebSocket
 * 客户端连接，tokenManager 用临时 token 文件（持久化已知 token）实现认证模式。S6 用
 * ServerMessageBroker 遍历 cm.clients 验证 broadcast 到达/不到达。S3/S7 用 fake timers
 * 控制超时与上限计数的确定性。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/connection-manager.auth.test.ts
 *
 * M4 注意：kickExistingClient 当前行为——旧连接被 close(4002)，但其 close handler 因
 * ctx.ws !== oldWs（clientId 已被新连接占用）跳过 onDisconnect 回调（见 connection-manager.ts:561 注释）。
 * 本测试 S5 以「旧连接收到 close(4002,'replaced') + 新连接留池」为可观察契约，不断言旧连接
 * 的 onDisconnect（当前实现不触发；若 M4 改为显式触发，本测试需相应更新）。
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
import type { ServerMessage } from '@xyz-agent/shared'

// ── 临时 token 文件 fixture（每个测试用唯一 token 文件隔离） ────────────────

interface TokenFixture {
  /** token 文件绝对路径（认证模式 tokenManager 读取）。 */
  file: string
  /** 已持久化的明文 token（客户端 auth payload 携带此值）。 */
  token: string
  /** 清理：删除 token 文件。 */
  cleanup: () => void
}

/**
 * 创建临时 token 文件（0o600 权限）写入已知 token。
 * 与 TokenManager.persist 同语义，但 token 由调用方指定（确定性测试）。
 */
function makeTokenFixture(token: string): TokenFixture {
  const dir = mkdtempSync(join(tmpdir(), 'xyz-auth-test-'))
  const file = join(dir, 'token')
  writeFileSync(file, token, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  // eslint-disable-next-line taste/no-silent-catch -- 非 POSIX FS（Windows）不支持 chmod，不阻断
  } catch {
    // 权限模型不可用时跳过（与 TokenManager.persist 同取舍）
  }
  return {
    file,
    token,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      // eslint-disable-next-line taste/no-silent-catch -- cleanup 失败不阻断测试结果
      } catch {
        // tmpdir 系统清理兜底，测试不依赖
      }
    },
  }
}

// ── 回调集合（vi.fn 便于断言可观察行为） ─────────────────────────────────

interface CallbackSpies {
  onConnect: ReturnType<typeof vi.fn>
  onMessage: ReturnType<typeof vi.fn>
  onDisconnect: ReturnType<typeof vi.fn>
  sendError: ReturnType<typeof vi.fn>
  onAuthSuccess: ReturnType<typeof vi.fn>
}

function makeCallbacks(): { spies: CallbackSpies; callbacks: ConnectionCallbacks } {
  const onConnect = vi.fn()
  const onMessage = vi.fn().mockResolvedValue(undefined)
  const onDisconnect = vi.fn()
  const sendError = vi.fn()
  const onAuthSuccess = vi.fn(async (
    _ws: WebSocket,
    _clientId: string,
    _input: AuthReplayInput,
  ): Promise<ReplayDecision> => ({
    resume: false,
    messages: [],
    seqReset: false,
    replayedCount: 0,
    bootId: 'test-boot',
    serverSeq: 0,
  }))
  const callbacks: ConnectionCallbacks = {
    onConnect: (ws, clientId) => onConnect(ws, clientId),
    onMessage: (msg, ws, clientId) => onMessage(msg, ws, clientId),
    onDisconnect: (ws, clientId) => onDisconnect(ws, clientId),
    sendError: (ws, code, message, id, details) => sendError(ws, code, message, id, details),
    onAuthSuccess,
  }
  return { spies: { onConnect, onMessage, onDisconnect, sendError, onAuthSuccess }, callbacks }
}

// ── wss 启停 helper（自由端口 + tokenManager 认证模式） ──────────────────────

interface Harness {
  cm: ConnectionManager
  spies: CallbackSpies
  port: number
  token: string
  /** 关闭 wss + http server（不抛错）。 */
  close: () => Promise<void>
}

/**
 * 启动一个认证模式 ConnectionManager（自由端口）。
 * @param fixture token 文件 fixture（makeTokenFixture 创建）
 */
async function startAuthHarness(fixture: TokenFixture): Promise<Harness> {
  const { ConnectionManager } = await import('../connection-manager.js')
  const { spies, callbacks } = makeCallbacks()
  // 自由端口（与 lease 测试同范式：30000 + random offset；进程退出即释放）
  const port = 31000 + Math.floor(Math.random() * 1000)
  const tokenManager = createTokenManager({ tokenFile: fixture.file })
  const cm = new ConnectionManager(port, callbacks, { tokenManager, serverVersion: 'test-1.0' })
  await cm.start()
  return {
    cm,
    spies,
    port,
    token: fixture.token,
    close: async () => { await cm.stop() },
  }
}

// ── WS 客户端连接 helper（等 open / 收 close / 收 message） ──────────────────

interface ConnectResult {
  ws: WebSocket
  /** 等待下一条 WS message（解析 JSON），带超时。 */
  nextMessage: (timeoutMs?: number) => Promise<{ type: string; [key: string]: unknown }>
  /** 等待 close 事件，返回 { code, reason }。 */
  waitForClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>
}

function connectWs(url: string): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const messageQueue: Array<{ type: string; [key: string]: unknown }> = []
    let closeResolver: ((v: { code: number; reason: string }) => void) | null = null

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
      waitForClose: (timeoutMs = 3000) => new Promise((res) => {
        const t = setTimeout(() => {
          res({ code: -1, reason: `waitForClose 超时 ${timeoutMs}ms` })
        }, timeoutMs)
        closeResolver = (v) => { clearTimeout(t); res(v) }
      }),
    }))
    ws.on('message', (raw) => {
      try {
        messageQueue.push(JSON.parse(raw.toString()))
      // eslint-disable-next-line taste/no-silent-catch -- 非 JSON message 不入队列（与 verify-remote-auth 同处理）
      } catch {
        // 忽略非 JSON（本测试所有消息均为 JSON）
      }
    })
    ws.on('close', (code, reasonBuf) => {
      if (closeResolver) closeResolver({ code, reason: reasonBuf ? reasonBuf.toString() : '' })
    })
    ws.on('error', (err) => {
      // error 通常伴随 close，仅在尚未 open 时 reject（连接建立失败）
      if (ws.readyState === WebSocket.CONNECTING) reject(err)
    })
  })
}

function sendAuth(ws: WebSocket, payload: { token: string; clientId: string; deviceName?: string }, id = 'auth-1'): void {
  ws.send(JSON.stringify({ type: 'auth', id, payload }))
}

// ── Tests ─────────────────────────────────────────────────────────

describe('ConnectionManager 认证门（spec §十三 #1：7 场景）', () => {
  let fixture: TokenFixture

  beforeEach(() => {
    vi.useRealTimers()
    // 每 test 一个唯一 token，避免跨用例污染（tokenManager 缓存按实例隔离，但 fixture 文件唯一更稳）
    fixture = makeTokenFixture('test-token-known-value-xyz')
  })
  afterEach(() => {
    fixture.cleanup()
  })

  // ── S1: token 对 ─────────────────────────────────────────────────

  it('S1 token 对：合法 auth → auth.ok + onConnect + 入正式池（authenticated 态）', async () => {
    const h = await startAuthHarness(fixture)
    try {
      const { ws, nextMessage } = await connectWs(`ws://127.0.0.1:${h.port}`)

      // 连接刚建立时尚未认证：不在正式池，onConnect 未触发
      expect(h.cm.clients.size).toBe(0)
      expect(h.spies.onConnect).not.toHaveBeenCalled()

      sendAuth(ws, { token: h.token, clientId: 'client-A', deviceName: 'mac-test' })

      // auth.ok 回复（首条消息）
      const authOk = await nextMessage(3000)
      expect(authOk.type).toBe('auth.ok')
      expect(authOk.payload).toMatchObject({
        serverVersion: 'test-1.0',
        clientId: 'client-A',
        resumed: false,
      })
      // P5 presence：auth.ok 顺带带 presence 全量列表（含刚入池的 client-A）
      expect(authOk.payload).toHaveProperty('presence')

      // 入正式池（authenticated 态）+ onConnect 触发
      await vi.waitFor(() => expect(h.cm.clients.has('client-A')).toBe(true))
      expect(h.cm.clients.get('client-A')?.deviceName).toBe('mac-test')
      expect(h.spies.onConnect).toHaveBeenCalledTimes(1)
      expect(h.spies.onConnect).toHaveBeenCalledWith(expect.any(WebSocket), 'client-A')

      // onAuthSuccess 被调（仅认证模式）
      expect(h.spies.onAuthSuccess).toHaveBeenCalledTimes(1)
      // 后续可正常路由业务消息（认证后 ws 已挂正式 message handler）
      ws.send(JSON.stringify({ type: 'ping', id: 'm1' }))
      await vi.waitFor(() => expect(h.spies.onMessage).toHaveBeenCalledTimes(1))

      ws.close()
    } finally {
      await h.close()
    }
  })

  // ── S2: token 错 ─────────────────────────────────────────────────

  it('S2 token 错：错误 token → close(4001, "unauthorized")，不入池', async () => {
    const h = await startAuthHarness(fixture)
    try {
      const { ws, waitForClose } = await connectWs(`ws://127.0.0.1:${h.port}`)

      sendAuth(ws, { token: 'WRONG-token-not-matching', clientId: 'client-bad' })

      const { code, reason } = await waitForClose(3000)
      expect(code).toBe(4001)
      expect(reason).toBe('unauthorized')

      // 不入正式池 + onConnect / onAuthSuccess 不触发（认证失败）
      expect(h.cm.clients.size).toBe(0)
      expect(h.spies.onConnect).not.toHaveBeenCalled()
      expect(h.spies.onAuthSuccess).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  // ── S3: 超时（auth_timeout） ─────────────────────────────────────

  it('S3 超时（auth_timeout）：连接后不发 auth → 超时 close(4001, "auth_timeout")',
    { timeout: 10000 }, // 真等 runtime AUTH_TIMEOUT_MS=5s 超时，vitest 默认 5s testTimeout 不够，放宽到 10s。
    async () => {
    // 用 fake timers 确定性触发 AUTH_TIMEOUT_MS（5s 真等过慢）。
    // 但 fake timers 会冻结 setTimeout，导致 ws 连接的底层 timer 也被冻——
    // 故先真连上（real timers），再切 fake timers 推进超时。
    vi.useRealTimers()
    const h = await startAuthHarness(fixture)
    try {
      const { ws, waitForClose } = await connectWs(`ws://127.0.0.1:${h.port}`)
      // 连上但不发 auth：ws 处于 pending（未入池）
      expect(h.cm.clients.size).toBe(0)

      // 真等超时（runtime AUTH_TIMEOUT_MS=5s，预留余量到 7s）
      const { code, reason } = await waitForClose(7000)
      expect(code).toBe(4001)
      expect(reason).toBe('auth_timeout')

      // 超时后 pending 清理（cm.clients 始终为 0，pending 内部 Set 也应清空）
      expect(h.cm.clients.size).toBe(0)
      expect(h.spies.onConnect).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  // ── S4: 首消息非 auth ────────────────────────────────────────────

  it('S4 首消息非 auth：首条消息 type !== "auth" → close(4001, "auth_required")', async () => {
    const h = await startAuthHarness(fixture)
    try {
      const { ws, waitForClose } = await connectWs(`ws://127.0.0.1:${h.port}`)

      // 首条消息发 ping（非 auth）
      ws.send(JSON.stringify({ type: 'ping', id: 'p1' }))

      const { code, reason } = await waitForClose(3000)
      expect(code).toBe(4001)
      expect(reason).toBe('auth_required')

      expect(h.cm.clients.size).toBe(0)
      expect(h.spies.onConnect).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  // ── S5: 同 clientId 挤占（kick） ────────────────────────────────

  it('S5 同 clientId 挤占（kick）：新连接用已存在 clientId → 旧连接 close(4002, "replaced")，新连接留池', async () => {
    const h = await startAuthHarness(fixture)
    try {
      // 第一个连接认证成功（clientId='dup', deviceName='device-1'）
      const c1 = await connectWs(`ws://127.0.0.1:${h.port}`)
      sendAuth(c1.ws, { token: h.token, clientId: 'dup', deviceName: 'device-1' })
      await c1.nextMessage(3000) // auth.ok
      await vi.waitFor(() => expect(h.cm.clients.get('dup')?.deviceName).toBe('device-1'))

      // 第二个同 clientId 连接认证成功 → 触发 kick（新连接 deviceName='device-2'）
      const c2 = await connectWs(`ws://127.0.0.1:${h.port}`)
      sendAuth(c2.ws, { token: h.token, clientId: 'dup', deviceName: 'device-2' })

      // 旧连接 c1 收到 close(4002, 'replaced')
      const c1Close = await c1.waitForClose(3000)
      expect(c1Close.code).toBe(4002)
      expect(c1Close.reason).toBe('replaced')

      // 新连接 c2 认证成功（auth.ok + 留池）。注：客户端 ws 与服务端持有的 ws 是不同实例
      // （TCP 两端），故用 deviceName（来自 auth payload，存入 ConnectionCtx）断言留池身份，
      // 而非 ws 引用相等。
      const c2AuthOk = await c2.nextMessage(3000)
      expect(c2AuthOk.type).toBe('auth.ok')
      await vi.waitFor(() => expect(h.cm.clients.get('dup')?.deviceName).toBe('device-2'))
      expect(h.cm.clients.has('dup')).toBe(true)

      // M4 当前行为注记：被 kick 的旧连接 c1 的 close handler 因 clientId 已被 c2 占用
      // （ctx.ws !== c1.ws）跳过 onDisconnect。本断言验证「旧连接 ws 一致性检查不误删新连接」——
      // clients.get('dup') 仍存在且 deviceName 指向 c2（而非被 c1 close 误清）。若 M4 改为
      // 显式触发旧连接 onDisconnect，可追加 expect(h.spies.onDisconnect).toHaveBeenCalledTimes(1)。
      expect(h.cm.clients.get('dup')?.deviceName).toBe('device-2')

      c2.ws.close()
    } finally {
      await h.close()
    }
  })

  // ── S6: 未认证不进广播池 ─────────────────────────────────────────

  it('S6 未认证不进广播池：未完成 auth 的连接不接收 broadcast（broker.broadcast 不投递）', async () => {
    const h = await startAuthHarness(fixture)
    try {
      // 1) 先认证一个 client-A（进入正式池，对照验证 broadcast 确实会到达已认证连接）
      const cAuth = await connectWs(`ws://127.0.0.1:${h.port}`)
      sendAuth(cAuth.ws, { token: h.token, clientId: 'client-A' })
      await cAuth.nextMessage(3000) // auth.ok
      await vi.waitFor(() => expect(h.cm.clients.has('client-A')).toBe(true))

      // 2) 再开一个未认证连接（停在 pending，不发 auth）
      const cPending = await connectWs(`ws://127.0.0.1:${h.port}`)
      // pending 连接不在 cm.clients（广播池）中
      expect(h.cm.clients.has('local')).toBe(false)
      expect(Array.from(h.cm.clients.keys())).toEqual(['client-A'])

      // 3) 用 ServerMessageBroker 广播（与 production 同路径：遍历 cm.clients.values()）
      const { ServerMessageBroker } = await import('../message-broker.js')
      const broker = new ServerMessageBroker(
        h.cm,
        {
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
        } as never,
      )
      const broadcastMsg: ServerMessage = {
        type: 'app.info',
        payload: { appVersion: '1', piVersion: '1' },
      } as never
      broker.broadcast(broadcastMsg)

      // 4) 已认证连接 client-A 收到广播
      const received = await cAuth.nextMessage(3000)
      expect(received.type).toBe('app.info')

      // 5) 未认证连接 cPending 不应收到任何业务消息（pending 不在广播池）。
      //    用 race 验证：300ms 内 cPending 不来任何消息（auth.ok / app.info 均无）。
      const leaked = await Promise.race([
        cPending.nextMessage(300).then(
          (m) => `unexpected message: ${m.type}`,
          () => 'timeout-ok',
        ),
        new Promise<string>((res) => setTimeout(() => res('no-message-ok'), 350)),
      ])
      expect(leaked).not.toContain('unexpected message')

      // pending 连接确实未触发 onConnect / onAuthSuccess
      expect(h.spies.onConnect).toHaveBeenCalledTimes(1) // 仅 client-A
      cAuth.ws.close()
      cPending.ws.close()
    } finally {
      await h.close()
    }
  })

  // ── S7: 未认证上限（MAX_PENDING/server_busy） ────────────────────

  it('S7 未认证上限（MAX_PENDING/server_busy）：pending 满 → 新连接立即 close(4001, "server_busy")', async () => {
    const h = await startAuthHarness(fixture)
    try {
      // MAX_PENDING 在 connection-manager 模块内是私有常量（=20）。生产代码用 >= 判定：
      // pending.size 达到 20 时，第 21 个连接立即被 server_busy 拒绝。
      // 用真实连接占满 20 个 pending 槽位（均不发 auth），再连第 21 个断言被拒。
      const MAX_PENDING = 20
      const pendingConns: ConnectResult[] = []
      for (let i = 0; i < MAX_PENDING; i++) {
        // 不 await nextMessage（pending 连接不会收 auth.ok）；只等 open
        const c = await connectWs(`ws://127.0.0.1:${h.port}`)
        pendingConns.push(c)
      }
      // 全部在 pending，无一入正式池
      expect(h.cm.clients.size).toBe(0)

      // 第 21 个连接立即被 server_busy 拒绝
      const c21 = await connectWs(`ws://127.0.0.1:${h.port}`)
      const { code, reason } = await c21.waitForClose(3000)
      expect(code).toBe(4001)
      expect(reason).toBe('server_busy')

      // 仍未入池
      expect(h.cm.clients.size).toBe(0)

      // 清理 pending 连接（避免 fake/real timer 残留）
      for (const c of pendingConns) {
        try { c.ws.close() } catch { /* 已关闭 */ }
      }
    } finally {
      await h.close()
    }
  })
})
