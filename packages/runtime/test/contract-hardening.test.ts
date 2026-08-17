/**
 * contract-hardening.test.ts — api-contract-hardening slice 单元验收（S3-W1 + S3-W2）
 *
 * 覆盖（后续批次在此文件追加限流/毒化隔离/窄校验用例）：
 * - 命令执行链复合键：插件 B 无法覆盖/注销插件 A 的同名命令（register/unregister
 *   按 `pluginId:commandId` 复合键隔离）；commandId 含 ':' 被拒；sandbox 通道
 *   身份覆写后伪冒 pluginId 不改变键归属
 * - runtime→Worker 发送段闭环：executeCommand 经 rpcServer.notify 发
 *   plugin.commands.invoke（mock Worker port 收到），Worker 经
 *   plugin.commands.invoke.result 回传结果/错误 → pending resolve/reject
 * - sessions 定向投递：registerCreate/registerDestroy 建注册表（handlerId →
 *   workerId），didCreate/didDestroy 只投递到注册 Worker；unregister /
 *   clearForPlugin 停止投递
 * - sessions 创建入口收敛：lifecycle create / restoreSession / forkSession 三处
 *   spawn 路径均触发 notifySessionCreated；销毁汇聚点 removeSessionEntry 触发
 *   onSessionDestroyed
 * - events 显式降级：api.events.on / emit 调用即抛 NOT_IMPLEMENTED（含 issue 指引）
 *
 * 运行：cd packages/runtime && npx vitest run test/contract-hardening.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// fork 用例 mock 截断函数（真实 createForkedSessionFile 操作 sessions 数据目录，
// 单测无该基建；返回受控 filePath 指向真实 tmp 文件供后续 strip/switch 流程使用）
vi.mock('../src/services/session/session-fork.js', () => ({
  createForkedSessionFile: vi.fn(async () => ({ filePath: '', sessionId: 'fork-1' })),
}))

import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { WorkerPort } from '../src/services/plugin-service/plugin-rpc-server.js'
import {
  registerCommandRpcHandlers,
  commandCompositeKey,
  COMMAND_RPC_METHODS,
} from '../src/services/plugin-service/api/commands-api.js'
import type { CommandRegistration } from '../src/services/plugin-service/api/commands-api.js'
import {
  SessionEventDispatch,
  SESSION_EVENT_METHODS,
  registerSessionRpcHandlers,
} from '../src/services/plugin-service/api/session-api.js'
import type { SessionInfo } from '../src/services/plugin-service/plugin-types.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import { createAgentAPI } from '../src/services/plugin-service/plugin-bootstrap.js'
import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import { SessionService } from '../src/services/session/session-service.js'
import type { ISessionServiceInternal } from '../src/services/session/session-internal.js'
import type { IProcessManager } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { IExtensionService, IMessageBroker } from '../src/interfaces.js'
import type { IManagedSessionView, ScannedSession } from '../src/services/session/types.js'
import type { SessionSummary } from '@xyz-agent/shared'

// ══════════════════════════════════════════════════════════════════
// 共用测试基建
// ══════════════════════════════════════════════════════════════════

/** 记录 postMessage 收到的消息（plugin-rpc.test.ts 同款） */
function createMockPort(): WorkerPort & { messages: Array<Record<string, unknown>> } {
  const messages: Array<Record<string, unknown>> = []
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg as Record<string, unknown>)
    },
  }
}

function createMockBroker(): IMessageBroker {
  return { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() }
}

/** 从 mock port 收到的消息中提取全部 rpc 通知（method + params） */
function notificationsOf(port: { messages: Array<Record<string, unknown>> }): Array<{ method: string; params: Record<string, unknown> }> {
  return port.messages
    .filter(m => m.type === 'rpc' && (m as { notification?: unknown }).notification)
    .map(m => {
      const n = (m as { notification: { method: string; params: Record<string, unknown> } }).notification
      return { method: n.method, params: n.params }
    })
}

/** 构造最小 lifecycle 环境（session-lifecycle-gate.test.ts 同款模式） */
function makeLifecycleEnv() {
  const svc = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    initializeManagedSession: vi.fn(async (id: string) => ({ id }) as unknown as IManagedSessionView),
    toSummary: vi.fn((s: IManagedSessionView): SessionSummary => ({
      id: s.id, label: `label-${s.id}`, cwd: '/tmp', status: 'active',
      lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0,
    })),
    findScannedSession: vi.fn((): ScannedSession | undefined => undefined),
    getSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(() => undefined),
    // S3-W2 被测收敛点
    notifySessionCreated: vi.fn(),
  } as unknown as ISessionServiceInternal
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'sess-1', sessionFile: undefined })),
    switchSession: vi.fn(async () => undefined),
  }
  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    patchSessionCwd: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService)
  return { svc, pm, configStore, sessionStore, workspaceService, client, lifecycle }
}

// ══════════════════════════════════════════════════════════════════
// S3-W1 — 命令表复合键隔离
// ══════════════════════════════════════════════════════════════════

describe('命令表复合键隔离（pluginId:commandId）', () => {
  let rpc: PluginRpcServer
  let registry: Map<string, CommandRegistration>
  let port: ReturnType<typeof createMockPort>

  beforeEach(() => {
    rpc = new PluginRpcServer()
    registry = new Map()
    port = createMockPort()
    rpc.registerWorker('w1', port)
    registerCommandRpcHandlers(rpc, {
      registry,
      broadcastRegistered: vi.fn(),
      deliverInvokeResult: vi.fn(),
    })
  })

  function dispatchRegister(workerId: string, pluginId: string, commandId: string, handlerId: string): Promise<void> {
    return rpc.dispatch(workerId, {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 100000),
      method: COMMAND_RPC_METHODS.register,
      params: { pluginId, command: { id: commandId }, handlerId },
    })
  }

  it('插件 A 与插件 B 注册同名命令 x：registry 两条共存，B 不覆盖 A', async () => {
    await dispatchRegister('w1', 'A', 'x', 'h-A')
    await dispatchRegister('w1', 'B', 'x', 'h-B')

    expect(registry.get(commandCompositeKey('A', 'x'))).toMatchObject({ pluginId: 'A', handlerId: 'h-A' })
    expect(registry.get(commandCompositeKey('B', 'x'))).toMatchObject({ pluginId: 'B', handlerId: 'h-B' })
    expect(registry.size).toBe(2)
  })

  it('插件 B 注销 x 只删自身（B:x），A:x 不受影响', async () => {
    await dispatchRegister('w1', 'A', 'x', 'h-A')
    await dispatchRegister('w1', 'B', 'x', 'h-B')

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 2,
      method: COMMAND_RPC_METHODS.unregister,
      params: { pluginId: 'B', commandId: 'x' },
    })

    expect(registry.has(commandCompositeKey('A', 'x'))).toBe(true)
    expect(registry.has(commandCompositeKey('B', 'x'))).toBe(false)
  })

  it('插件 B 传注入形态 commandId="A:x" 注销：键为 B:A:x（不存在），A:x 原样保留', async () => {
    await dispatchRegister('w1', 'A', 'x', 'h-A')

    await rpc.dispatch('w1', {
      jsonrpc: '2.0',
      id: 3,
      method: COMMAND_RPC_METHODS.unregister,
      params: { pluginId: 'B', commandId: 'A:x' },
    })

    expect(registry.has(commandCompositeKey('A', 'x'))).toBe(true)
    expect(registry.size).toBe(1)
  })

  it('register 拒绝含 ":" 的 commandId（复合键注入防护），注册失败返回错误响应', async () => {
    await dispatchRegister('w1', 'B', 'A:x', 'h-inject')

    expect(registry.size).toBe(0)
    const responses = port.messages.filter(m => m.type === 'rpc' && (m as { response?: unknown }).response)
    const last = responses[responses.length - 1] as { response: { error?: { message: string } } }
    expect(last.response.error?.message).toContain('INVALID_COMMAND_ID')
  })

  it('sandbox 通道身份覆写：插件 B 伪冒 pluginId="A" 注册，键仍按通道身份 B 隔离', async () => {
    // 宿主已注册的通道身份（security slice resolveIdentity 同款装配）
    rpc.registerIdentity('w1', { trustLevel: 'sandbox', pluginId: 'B' })
    await dispatchRegister('w1', 'A', 'x', 'h-spoof') // 消息体自报 pluginId='A'

    // dispatch 身份覆写后 params.pluginId 被强制改为 'B' → 键 B:x，A:x 未被伪造
    expect(registry.has(commandCompositeKey('A', 'x'))).toBe(false)
    expect(registry.get(commandCompositeKey('B', 'x'))).toMatchObject({ pluginId: 'B', handlerId: 'h-spoof' })
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W1 — runtime→Worker 发送段闭环（executeCommand → invoke 通知 → result 回传）
// ══════════════════════════════════════════════════════════════════

describe('命令执行发送段闭环（executeCommand → plugin.commands.invoke → invoke.result）', () => {
  let tmpDir: string
  let service: PluginService
  let rpcServer: PluginRpcServer
  let port: ReturnType<typeof createMockPort>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'contract-cmd-'))
    const registryMock = {
      getDescriptor: vi.fn(() => ({ pluginId: 'p1', pluginPath: '/tmp/p1' })),
      getAllDescriptors: () => [],
    }
    service = new PluginService(registryMock as never, createMockBroker(), { configDir: tmpDir })
    // 真实 RPC 方法注册（含 plugin.commands.invoke.result）
    ;(service as unknown as { registerRpcMethods(): void }).registerRpcMethods()
    rpcServer = (service as unknown as { rpcServer: PluginRpcServer }).rpcServer
    port = createMockPort()
    rpcServer.registerWorker('w1', port)
    // 预置命令注册表条目（register 链路由复合键用例覆盖；此处聚焦发送段）
    const commandRegistry = (service as unknown as { commandRegistry: Map<string, CommandRegistration> }).commandRegistry
    commandRegistry.set(commandCompositeKey('p1', 'cmd1'), {
      commandId: 'cmd1', pluginId: 'p1', handlerId: 'h1', registeredAt: Date.now(),
    })
    // host 替换：getWorkerHandle 返回受控 workerId（PluginHost 真实装配归集成层）
    ;(service as unknown as {
      host: { getWorkerHandle: (pluginId: string) => { workerId: string } | undefined }
    }).host = { getWorkerHandle: () => ({ workerId: 'w1' }) }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 模拟 Worker 侧 invoke.result 回传（经真实 dispatch → deliverInvokeResult → pending） */
  function workerReplies(handlerId: string, payload: { result?: unknown; error?: unknown }): Promise<void> {
    return rpcServer.dispatch('w1', {
      jsonrpc: '2.0',
      id: 99000 + Math.floor(Math.random() * 999),
      method: COMMAND_RPC_METHODS.invokeResult,
      params: { handlerId, ...payload },
    })
  }

  it('executeCommand 向 Worker 发 plugin.commands.invoke（handlerId+args）并经 result 回传拿到返回值', async () => {
    const pending = service.executeCommand('p1', 'cmd1', { x: 1 })
    // 发送段：Worker port 收到 invoke 通知（方法名常量 + 复合键对应的 handlerId）
    await vi.waitFor(() => {
      const invokes = notificationsOf(port).filter(n => n.method === COMMAND_RPC_METHODS.invoke)
      expect(invokes).toHaveLength(1)
      expect(invokes[0]!.params).toEqual({ handlerId: 'h1', args: { x: 1 } })
    })

    await workerReplies('h1', { result: 'result-ok' })
    await expect(pending).resolves.toBe('result-ok')
  })

  it('Worker 回传 error 字段：executeCommand 以含错误信息的 Error reject', async () => {
    const pending = service.executeCommand('p1', 'cmd1', {})
    await vi.waitFor(() => {
      expect(notificationsOf(port).some(n => n.method === COMMAND_RPC_METHODS.invoke)).toBe(true)
    })

    await workerReplies('h1', { error: 'handler blew up' })
    await expect(pending).rejects.toThrow('handler blew up')
  })

  it('executeCommand 查复合键：未注册的命令（B:x 未注册）报 Command not found 且不发通知', async () => {
    await expect(service.executeCommand('B', 'x', {})).rejects.toThrow('Command not found: B:x')
    expect(notificationsOf(port).some(n => n.method === COMMAND_RPC_METHODS.invoke)).toBe(false)
  })

  it('并发执行同一命令被拒绝（pending 登记表防覆盖）', async () => {
    const first = service.executeCommand('p1', 'cmd1', {})
    await expect(service.executeCommand('p1', 'cmd1', {})).rejects.toThrow('already executing')
    // 收尾：resolve 第一个，避免悬挂 timer
    await workerReplies('h1', { result: undefined })
    await expect(first).resolves.toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W2 — session 事件注册表定向投递
// ══════════════════════════════════════════════════════════════════

describe('session 事件注册表定向投递（registerCreate → didCreate）', () => {
  let rpc: PluginRpcServer
  let dispatchTable: SessionEventDispatch
  let portA: ReturnType<typeof createMockPort>
  let portB: ReturnType<typeof createMockPort>

  beforeEach(() => {
    rpc = new PluginRpcServer()
    dispatchTable = new SessionEventDispatch(rpc)
    portA = createMockPort()
    portB = createMockPort()
    rpc.registerWorker('wA', portA)
    rpc.registerWorker('wB', portB)
    registerSessionRpcHandlers(rpc, {
      listSessions: () => [],
      getSession: () => undefined,
      getActiveSession: () => undefined,
      sendMessage: async () => {},
      sessionEvents: dispatchTable,
    })
  })

  const session: SessionInfo = {
    id: 's1', label: 'L', cwd: '/tmp', status: 'active', createdAt: 0, lastActiveAt: 0,
  }

  /** 经真实 dispatch 注册一个 create/destroy handler（handler 内部从 ctx 取 workerId） */
  function registerHandler(kind: 0 | 1, workerId: string, handlerId: string, pluginId: string): Promise<void> {
    return rpc.dispatch(workerId, {
      jsonrpc: '2.0',
      id: 1000 + Math.floor(Math.random() * 999),
      method: SESSION_EVENT_METHODS[kind],
      params: { pluginId, handlerId },
    })
  }

  it('didCreate 只投递到注册 create 的 Worker（含 handlerId + session），其余 Worker 不收', async () => {
    await registerHandler(0, 'wA', 'hc-A', 'pluginA')

    dispatchTable.didCreate(session)

    const notes = notificationsOf(portA)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.method).toBe('plugin.sessions.didCreate')
    expect(notes[0]!.params).toEqual({ handlerId: 'hc-A', session })
    expect(notificationsOf(portB)).toHaveLength(0)
  })

  it('create 与 destroy 双表隔离：didDestroy 不触发 create 订阅者', async () => {
    await registerHandler(0, 'wA', 'hc-A', 'pluginA')
    await registerHandler(1, 'wB', 'hd-B', 'pluginB')

    dispatchTable.didDestroy(session)

    expect(notificationsOf(portA)).toHaveLength(0)
    const notes = notificationsOf(portB)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.method).toBe('plugin.sessions.didDestroy')
    expect(notes[0]!.params).toEqual({ handlerId: 'hd-B', session })
  })

  it('unregisterCreate 后不再投递（Worker dispose 对偶）', async () => {
    await registerHandler(0, 'wA', 'hc-A', 'pluginA')
    await rpc.dispatch('wA', {
      jsonrpc: '2.0', id: 77, method: 'plugin.sessions.unregisterCreate', params: { handlerId: 'hc-A' },
    })

    dispatchTable.didCreate(session)

    expect(notificationsOf(portA)).toHaveLength(0)
  })

  it('clearForPlugin 清空该插件全部订阅（crash/disable/uninstall 对偶清理）', async () => {
    await registerHandler(0, 'wA', 'hc-A', 'pluginA')
    await registerHandler(1, 'wB', 'hd-B', 'pluginB')

    dispatchTable.clearForPlugin('pluginA')
    dispatchTable.didCreate(session)
    dispatchTable.didDestroy(session)

    expect(notificationsOf(portA)).toHaveLength(0)
    expect(notificationsOf(portB)).toHaveLength(1) // pluginB 的 destroy 订阅不受影响
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W2 — session 创建/销毁入口收敛触发
// ══════════════════════════════════════════════════════════════════

describe('session 创建入口收敛触发 notifySessionCreated', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    tmpDir = mkdtempSync(join(tmpdir(), 'contract-sess-'))
  })

  afterEach(() => {
    setMigrationGate(Promise.resolve())
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lifecycle.create 成功 → notifySessionCreated 恰好一次且 summary 为新 session', async () => {
    const { lifecycle, svc } = makeLifecycleEnv()
    const summary = await lifecycle.create('/tmp', 'test')

    expect(summary.id).toBe('sess-1')
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(1)
    expect(svc.notifySessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1', status: 'active' }))
  })

  it('lifecycle.restoreSession 成功 → notifySessionCreated 触发（restore 也是创建入口）', async () => {
    const { lifecycle, svc } = makeLifecycleEnv()
    // 持久化 session 文件（restore 读取 JSONL strip；两行最小合法内容即可）
    const filePath = join(tmpDir, 'sess-9.jsonl')
    writeFileSync(filePath, '{"type":"session","id":"sess-9"}\n{"type":"message","id":"e1"}\n')
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'sess-9', filePath, cwd: tmpDir, name: 'restored', launchPresetId: undefined, projectId: undefined,
    })

    const summary = await lifecycle.restoreSession('sess-9')

    expect(summary.id).toBe('sess-9')
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(1)
    expect(svc.notifySessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-9' }))
  })

  it('lifecycle.forkSession 成功 → notifySessionCreated 触发（fork 也是创建入口）', async () => {
    const { lifecycle, svc } = makeLifecycleEnv()
    const sourceFile = join(tmpDir, 'sess-src.jsonl')
    writeFileSync(sourceFile, '{"type":"session","id":"sess-src"}\n{"type":"message","id":"e1"}\n')
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'sess-src', filePath: sourceFile, cwd: tmpDir, name: 'src', launchPresetId: undefined, projectId: undefined,
    })
    // vi.mock 的 createForkedSessionFile 返回受控产物（filePath 指向真实 tmp 文件，
    // 供 fork 内部 readFileSync(strip) + switchSession 流程消费）
    const forkedFile = join(tmpDir, 'fork-1.jsonl')
    writeFileSync(forkedFile, '{"type":"session","id":"fork-1"}\n')
    const { createForkedSessionFile } = await import('../src/services/session/session-fork.js')
    ;(createForkedSessionFile as ReturnType<typeof vi.fn>).mockResolvedValue({ filePath: forkedFile, sessionId: 'fork-1' })

    const summary = await lifecycle.forkSession('sess-src', 'e1', true, 'forked')

    expect(summary.id).toBe('fork-1')
    expect(svc.notifySessionCreated).toHaveBeenCalledTimes(1)
    expect(svc.notifySessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'fork-1' }))
  })

  it('lifecycle.create 失败（pi 无 session id）→ notifySessionCreated 不触发', async () => {
    const { lifecycle, svc, pm } = makeLifecycleEnv()
    ;(pm.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      getState: async () => ({ sessionId: '', sessionFile: undefined }),
    })

    await expect(lifecycle.create('/tmp')).rejects.toThrow('session ID')
    expect(svc.notifySessionCreated).not.toHaveBeenCalled()
  })
})

describe('session 销毁汇聚点触发 onSessionDestroyed', () => {
  it('removeSessionEntry 触发 setOnSessionDestroyed 注册的回调（fallback summary 带 sessionId）', () => {
    const pm = {
      onSessionExit: vi.fn(),
      getClient: vi.fn(() => undefined),
      destroySession: vi.fn(async () => {}),
      destroyAll: vi.fn(async () => {}),
    } as unknown as ConstructorParameters<typeof SessionService>[0]
    const broker = createMockBroker()
    const adapterFactory = vi.fn()
    const extensionService = {} as unknown as IExtensionService
    const configStore = {} as unknown as IConfigStore
    const sessionStore = {} as unknown as ISessionStore
    const gitInfoReader = {} as unknown as ConstructorParameters<typeof SessionService>[7]
    const workspaceService = {} as unknown as WorkspaceService

    const svc = new SessionService(
      pm, broker, adapterFactory, '/project-root', extensionService,
      configStore, sessionStore, gitInfoReader, workspaceService,
    )

    const destroyed: SessionSummary[] = []
    svc.setOnSessionDestroyed(summary => destroyed.push(summary))

    // 不进 Map 直接删（Map 无条目走最小 summary fallback——触发逻辑与富化分支同点）
    svc.removeSessionEntry('s-gone')

    expect(destroyed).toHaveLength(1)
    expect(destroyed[0]!.id).toBe('s-gone')
    expect(destroyed[0]!.status).toBe('dead')
  })
})

// ══════════════════════════════════════════════════════════════════
// S3-W2 — events 显式降级（NOT_IMPLEMENTED）
// ══════════════════════════════════════════════════════════════════

describe('events 面显式降级：调用即抛 NOT_IMPLEMENTED', () => {
  it('api.events.on 调用即抛，错误含 NOT_IMPLEMENTED 与 issue 指引', () => {
    const api = createAgentAPI('p1')
    expect(() => api.events.on('some-event', () => {})).toThrow(/NOT_IMPLEMENTED/)
    expect(() => api.events.on('some-event', () => {})).toThrow(/zhushanwen321\/xyz-agent\/issues/)
  })

  it('api.events.emit 调用即抛，错误含 NOT_IMPLEMENTED 与 issue 指引', () => {
    const api = createAgentAPI('p1')
    expect(() => api.events.emit('some-event', { a: 1 })).toThrow(/NOT_IMPLEMENTED/)
    expect(() => api.events.emit('some-event', { a: 1 })).toThrow(/zhushanwen321\/xyz-agent\/issues/)
  })
})
