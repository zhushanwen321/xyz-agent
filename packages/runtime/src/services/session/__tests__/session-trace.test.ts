/**
 * session-trace runtime 数据通路测试（trace-runtime 单元，spec A31/A32/A33）。
 *
 * mock 保真度（A31 mockFidelityNote）：仅 mock WS/RPC 传输边界——pi 的 get_entries 返回值
 * 来自本地 pi CLI 真实录制 fixture（__fixtures__/get-entries-*.json，录制脚本
 * scripts/record-get-entries-fixtures.mjs），文件读取走真实 infra 实现（readFirstJsonlLine /
 * readSessionEndMeta / readFileSync），不 mock pi 内部解析逻辑。
 *
 * - A31：session.getTraceEntries 活跃路径——RPC get_entries 路由 + header 首行补读
 *   （parentSession 两种形态）+ WS reply session.traceEntries（含 sessionId，规则 7）。
 * - A32：非活跃路径文件直读——JSONL + sidecar 合并 + 损坏行容错 + 未落盘空态。
 * - A33：增量腿——四类触发事件 → get_entries(since) 拉取 → session.traceEntryAppended
 *   （含 sessionId）；lifecycle RPC（set_model / set_thinking_level）成功后主动补拉。
 *
 * 运行：cd packages/runtime && npx vitest run session-trace
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SessionService } from '../session-service.js'
import { EventInterpreter } from '../event-interpreter.js'
import { buildTraceSnapshotFromFile } from '../session-trace.js'
import { readFirstJsonlLine, readSessionEndMeta } from '../../../infra/pi/session-file-utils.js'
import { SessionMessageHandler } from '../../../transport/session-message-handler.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import type { IMessageBroker } from '../../../interfaces.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { ISessionStore, ScannedSessionMeta } from '../../ports/session.js'
import type { ServerMessage } from '@xyz-agent/shared'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

/** 加载 RPC 录制 fixture（pi CLI 真实响应，含 meta 头 + response）。 */
function loadRecorded(name: string): { data: { entries: unknown[]; leafId: string | null } } {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')) as {
    response: { data: { entries: unknown[]; leafId: string | null } }
  }
  return raw.response
}

/** 读 fixture JSONL 首行 header 的 session id（scanSessions 假元数据要用真实 id 对上）。 */
function fixtureSessionId(name: string): string {
  const first = readFirstJsonlLine(join(FIXTURES, `${name}.jsonl`))
  if (!first) throw new Error(`fixture ${name}.jsonl has no first line`)
  return (JSON.parse(first) as { id: string }).id
}

/**
 * 假 ISessionStore：发现层（scanSessions）假，读取层（trace 三读）全部委托真实 infra
 * （readFirstJsonlLine / readFileSync / readSessionEndMeta）——保真度锚点：文件读取代码
 * 路径是生产实现，mock 只替换「在哪个目录找文件」。
 */
function makeSessionStore(metas: ScannedSessionMeta[]): ISessionStore {
  return {
    scanSessions: () => metas,
    invalidateScanCache: () => {},
    refreshAll: () => {},
    persistSessionEnd: () => {},
    persistPresetBinding: () => {},
    persistProjectBinding: () => {},
    extractSessionOutcome: () => null,
    invalidateMetaCache: () => {},
    convertHistory: () => [],
    rebuildHistoryFromEntries: () => ({ messages: [], clientUuidMap: new Map(), orphanToolResults: [] }),
    parseSessionHeader: () => null,
    readSessionHeaderLine: (p: string) => readFirstJsonlLine(p),
    readSessionJsonlText: (p: string) => {
      try {
        return readFileSync(p, 'utf-8')
      } catch {
        return null
      }
    },
    readSessionEndMeta: (p: string) => readSessionEndMeta(p),
    persistHandoffSidecar: () => {},
    trash: () => {},
  }
}

function metaFor(name: string): ScannedSessionMeta {
  return {
    id: fixtureSessionId(name),
    filePath: join(FIXTURES, `${name}.jsonl`),
    cwd: '/tmp/trace-fixture',
    timestamp: '2026-08-20T00:00:00.000Z',
    name: null,
    lastModified: 0,
    size: 0,
    outcome: null,
  }
}

/**
 * 构造真实 SessionService + 真实 MessageBus 测试环境（session-service-w07-bus.test.ts 同模式）。
 * active=true 时 pm.getClient 返回 mock RPC client（getEntries 返回录制/构造响应）。
 */
function makeEnv(opts: { metas?: ScannedSessionMeta[]; active?: boolean } = {}) {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker
  const recorded = loadRecorded('get-entries-1-mixed-kinds')
  const client = {
    getCommands: vi.fn(async () => []),
    getState: vi.fn(async () => ({ thinkingLevel: 'low' })),
    setModel: vi.fn(async () => ({})),
    setThinkingLevel: vi.fn(async () => ({})),
    getEntries: vi.fn(async () => recorded),
  }
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => (opts.active === false ? undefined : (client as unknown as IPiEngine))),
  } as unknown as IProcessManager
  const bus = new MessageBus()
  const publishSpy = vi.spyOn(bus, 'publish')
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never,
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never,
    makeSessionStore(opts.metas ?? []),
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never,
    {} as never,
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, bus, publishSpy, broadcasts, client, pm }
}

/** SessionMessageHandler + 捕获 reply（session-message-handler-subscribe.test.ts 同模式）。 */
function makeHandler(svc: SessionService) {
  const replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[] = []
  const errors: { id: string | undefined; code: string; message: string }[] = []
  const handler = new SessionMessageHandler({
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      errors.push({ id, code, message })
    }),
    sessionService: svc,
  } as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  const WS = { readyState: 1, send: vi.fn() } as never
  return { handler, replies, errors, WS }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── A31：活跃路径 RPC get_entries 路由 + header 首行补读 + reply 带 sessionId ──

describe('A31 session.getTraceEntries 活跃路径（RPC get_entries + header 首行补读）', () => {
  it('活跃 session 路由到 RPC：entries/leafId 来自 pi 真实录制响应，header 由文件首行补读（parentSession 缺省形态）', async () => {
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const { svc, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')

    const snapshot = await svc.getTraceEntries(sid)

    expect(client.getEntries).toHaveBeenCalledWith() // 全量拉取（无 since）
    expect(snapshot.source).toBe('rpc')
    // entries 逐条 = pi 真实解析产物（mock 保真：录制 fixture 直出）
    expect(snapshot.entries).toEqual(recorded.data.entries)
    expect(snapshot.leafId).toBe(recorded.data.leafId)
    // header 补读：RPC getEntries() 不含 header（pi session-manager docstring），由文件首行补
    expect(snapshot.header).toBeDefined()
    expect(snapshot.header?.id).toBe(sid)
    expect(snapshot.header?.version).toBe(3)
    // RPC 路径 malformed 由文件解析补齐（pi get_entries 静默跳坏行；fixture 无坏行 → 空）
    expect(snapshot.malformed).toEqual([])
  })

  it('RPC 路径补齐文件坏行（G1 损坏行占位可见）：pi get_entries 静默跳过的坏行由文件解析占位，文件尾坏行不丢失', async () => {
    // GUI 实测回归：非活跃 session JSONL 尾部注入坏行后 session 又被激活（pi client 存在）→
    // RPC 路径曾硬编码 malformed=[]，坏行对 Trace 视图彻底不可见（design G1「损坏行必须以
    // 占位行可见、不静默丢失」在活跃路径失效）。复现形态 = 真实文件尾部坏行 + pi 语义
    // （get_entries 跳坏行返回全部 ok entry）。
    const tmp = mkdtempSync(join(tmpdir(), 'trace-rpc-malformed-'))
    const sid = 'rpc-tail-malformed-session'
    const okEntries = [
      { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'hello' } },
      { type: 'session_info', name: 'repro' },
    ]
    writeFileSync(
      join(tmp, 's.jsonl'),
      `${JSON.stringify({ type: 'session', version: 3, id: sid, cwd: tmp })}\n${JSON.stringify(okEntries[0])}\n${JSON.stringify(okEntries[1])}\n{invalid json!!!\n`,
    )
    const { svc, client } = makeEnv({
      metas: [{ ...metaFor('get-entries-1-mixed-kinds'), id: sid, filePath: join(tmp, 's.jsonl') }],
      active: true,
    })
    client.getEntries.mockResolvedValue({ data: { entries: okEntries, leafId: 'm1' } })

    const snapshot = await svc.getTraceEntries(sid)

    expect(snapshot.source).toBe('rpc')
    // entries 仍是 RPC 权威解析（pi 语义：跳坏行）
    expect(snapshot.entries).toEqual(okEntries)
    // 坏行由文件直读补齐（行号锚点供 renderer 归并穿插）
    expect(snapshot.malformed).toEqual([{ lineNumber: 4, raw: '{invalid json!!!' }])
  })

  it('fork header 的 parentSession sessionId-fallback 形态原样透传（runtime 不解析，溯源归消费端）', async () => {
    const recorded = loadRecorded('get-entries-3-fork-header')
    const { svc, client } = makeEnv({ metas: [metaFor('get-entries-3-fork-header')], active: true })
    client.getEntries.mockResolvedValue(recorded)
    const sid = fixtureSessionId('get-entries-3-fork-header')

    const snapshot = await svc.getTraceEntries(sid)
    expect(snapshot.header?.parentSession).toBe('s-fork-src') // 源 session 未落盘 → sessionId fallback 形态
  })

  it('fork header 的 parentSession 文件路径形态原样透传', async () => {
    // 临时构造路径形态 header（录制 fixture 只有 fallback 形态；路径形态 = 源已落盘）
    const tmp = mkdtempSync(join(tmpdir(), 'trace-a31-'))
    const sid = 'a31-path-form-session'
    writeFileSync(join(tmp, 's.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: sid, cwd: tmp, parentSession: '/sessions/2026-08-20T00-00-00-000Z_src.jsonl', forkEntryId: 'e-1' })}\n${JSON.stringify({ type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'hi' } })}\n`)
    const { svc, client } = makeEnv({
      metas: [{ ...metaFor('get-entries-1-mixed-kinds'), id: sid, filePath: join(tmp, 's.jsonl') }],
      active: true,
    })
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: null } })

    const snapshot = await svc.getTraceEntries(sid)
    expect(snapshot.header?.parentSession).toBe('/sessions/2026-08-20T00-00-00-000Z_src.jsonl')
    expect(snapshot.header?.forkEntryId).toBe('e-1')
  })

  it('RPC 失败（pi 进程异常）降级路径 B 文件直读（design §3.1 失败路径：source=file）', async () => {
    const { svc, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    client.getEntries.mockRejectedValue(new Error('pi process dead'))
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')

    const snapshot = await svc.getTraceEntries(sid)
    expect(snapshot.source).toBe('file')
    // 文件直读 entries 与录制 RPC entries 逐条一致（parity 前提，A24 全量断言见 trace-parity.test.ts）
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    expect(snapshot.entries).toEqual(recorded.data.entries)
  })

  it('WS 路由：session.getTraceEntries → reply session.traceEntries（payload 含 sessionId，规则 7）', async () => {
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const { svc, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    client.getEntries.mockResolvedValue(recorded)
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')
    const { handler, replies, errors, WS } = makeHandler(svc)

    await handler.handleSessionMessage(
      { type: 'session.getTraceEntries', id: 'req-t1', payload: { sessionId: sid } } as never,
      WS,
    )

    expect(errors).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(replies[0].type).toBe('session.traceEntries')
    // 规则 7：session 级 reply 必带 sessionId（缺失消息应被前端忽略）
    expect(replies[0].payload.sessionId).toBe(sid)
    expect(replies[0].payload.source).toBe('rpc')
    expect(replies[0].payload.leafId).toBe(recorded.data.leafId)
  })

  it('service 抛错 → error envelope（含 sessionId + 可操作恢复提示），不 reply 成功', async () => {
    const { svc, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    client.getEntries.mockRejectedValue(new Error('boom'))
    // 文件路径也炸（readSessionJsonlText mock 抛错）→ getTraceEntries 整体 reject
    const store = svc['sessionStore'] as unknown as ISessionStore
    store.readSessionJsonlText = () => { throw new Error('disk error') }
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')
    const { handler, replies, errors, WS } = makeHandler(svc)

    await handler.handleSessionMessage(
      { type: 'session.getTraceEntries', id: 'req-t2', payload: { sessionId: sid } } as never,
      WS,
    )
    expect(replies).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('trace_fetch_failed')
    expect(errors[0].message).toContain('disk error')
  })
})

// ── A32：非活跃路径文件直读 ──

describe('A32 session.getTraceEntries 非活跃路径（JSONL + sidecar 直读）', () => {
  const MALFORMED_META: ScannedSessionMeta = {
    id: 'a32-file-malformed',
    filePath: join(FIXTURES, 'file-path-malformed.jsonl'),
    cwd: '/tmp/trace-a32',
    timestamp: '2026-08-20T00:00:00.000Z',
    name: null,
    lastModified: 0,
    size: 0,
    outcome: null,
  }

  it('JSONL + sidecar 合并：header 提取、entries 按文件行序、无 id 行保留、sessionEnd 来自 .meta.json', async () => {
    const { svc } = makeEnv({ metas: [MALFORMED_META], active: false })
    const snapshot = await svc.getTraceEntries('a32-file-malformed')

    expect(snapshot.source).toBe('file')
    expect(snapshot.header?.id).toBe('a32-file-malformed')
    // 损坏行不进 entries（占位归 malformed），无 id 的 session_info 保留（真实文件侧支形态）
    expect(snapshot.entries.map((e) => (e as { type: string; id?: string }).type)).toEqual(['message', 'model_change', 'session_info'])
    // sidecar 合并：session_end 终态（BOUNDARY 行数据源）
    expect(snapshot.sessionEnd).toEqual({ type: 'session_end', outcome: 'done', timestamp: '2026-08-20T01:00:00.000Z' })
    // 文件路径无 leaf 概念
    expect(snapshot.leafId).toBeUndefined()
  })

  it('损坏行容错：占位保留行号与原文，不静默丢失（design §3.1 失败路径）', () => {
    const store = makeSessionStore([MALFORMED_META])
    const snapshot = buildTraceSnapshotFromFile('a32-file-malformed', MALFORMED_META.filePath, store)
    expect(snapshot.malformed).toEqual([
      { lineNumber: 3, raw: 'this line is not json at all' },
      { lineNumber: 5, raw: '{"broken": ' },
    ])
  })

  it('session 未落盘（pi 延迟写入窗口）→ source=empty 空态标记，不抛不创建文件', async () => {
    // 场景 1：扫描不到该 session（全新 session，文件从未存在）
    const env1 = makeEnv({ metas: [], active: false })
    const s1 = await env1.svc.getTraceEntries('never-flushed-sid')
    expect(s1.source).toBe('empty')
    expect(s1.entries).toEqual([])

    // 场景 2：扫描到路径但文件不存在（延迟写入窗口：scanner 元数据 vs 实际落盘竞态）
    const env2 = makeEnv({
      metas: [{ ...MALFORMED_META, id: 'pending-flush', filePath: '/nonexistent/dir/pending.jsonl' }],
      active: false,
    })
    const s2 = await env2.svc.getTraceEntries('pending-flush')
    expect(s2.source).toBe('empty')
    expect(s2.entries).toEqual([])
    expect(s2.header).toBeUndefined()
  })

  it('WS 路由：非活跃路径 reply session.traceEntries 同样含 sessionId（规则 7 双路径一致）', async () => {
    const { svc } = makeEnv({ metas: [MALFORMED_META], active: false })
    const { handler, replies, errors, WS } = makeHandler(svc)
    await handler.handleSessionMessage(
      { type: 'session.getTraceEntries', id: 'req-t3', payload: { sessionId: 'a32-file-malformed' } } as never,
      WS,
    )
    expect(errors).toHaveLength(0)
    expect(replies[0].type).toBe('session.traceEntries')
    expect(replies[0].payload.sessionId).toBe('a32-file-malformed')
    expect(replies[0].payload.source).toBe('file')
    expect(replies[0].payload.malformed).toHaveLength(2)
  })
})

// ── A33：增量腿（触发事件 → since 拉取 → session.traceEntryAppended；lifecycle 补拉）──

describe('A33 session-trace 增量腿（触发事件 → get_entries(since) → session.traceEntryAppended）', () => {
  it('EventInterpreter：message_end / agent_settled / entry_appended 三类触发事件 → onTraceSync(trigger)', () => {
    const onTraceSync = vi.fn()
    const send = vi.fn()
    const interpreter = new EventInterpreter('s-trig', { send, onTraceSync })

    for (const trigger of ['message_end', 'agent_settled', 'entry_appended'] as const) {
      interpreter.interpret([{ kind: 'trace-trigger', trigger }])
    }
    expect(onTraceSync).toHaveBeenCalledTimes(3)
    expect(onTraceSync).toHaveBeenNthCalledWith(1, 's-trig', 'message_end')
    expect(onTraceSync).toHaveBeenNthCalledWith(2, 's-trig', 'agent_settled')
    expect(onTraceSync).toHaveBeenNthCalledWith(3, 's-trig', 'entry_appended')
  })

  it('EventInterpreter：compaction_end（第四类触发）→ onTraceSync(compaction_end)', () => {
    const onTraceSync = vi.fn()
    const interpreter = new EventInterpreter('s-comp', { send: vi.fn(), onTraceSync })
    interpreter.interpret([{ kind: 'compaction-end', reason: 'manual', aborted: false }])
    expect(onTraceSync).toHaveBeenCalledWith('s-comp', 'compaction_end')
  })

  it('syncTraceEntries：触发后 get_entries(since=基线 leafId) 拉取 → 广播 session.traceEntryAppended（含 sessionId + delta + 新 leafId）', async () => {
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const { svc, bus, publishSpy, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    client.getEntries.mockResolvedValue(recorded)
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')

    // 打开 trace 视图（建立 since 基线）
    await svc.getTraceEntries(sid)
    publishSpy.mockClear()

    // 触发事件到达 → 增量腿：delta 从 pi 拉取（mock 传输层返回真实录制形状；按 since 分流
    // ——全量返回录制响应，since=基线返回 delta，since=新 leaf 返回空稳态）
    const deltaEntry = { type: 'message', id: 'delta-1', parentId: recorded.data.leafId, message: { role: 'assistant', content: 'new' } }
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return recorded
      if (since === recorded.data.leafId) return { data: { entries: [deltaEntry], leafId: 'delta-1' } }
      return { data: { entries: [], leafId: 'delta-1' } }
    })
    svc.syncTraceEntries(sid, 'message_end')

    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1))
    const [pubSid, msg] = publishSpy.mock.calls[0] as [string, ServerMessage]
    expect(pubSid).toBe(sid)
    expect(msg.type).toBe('session.traceEntryAppended')
    // 规则 7：增量推送必带 sessionId
    expect((msg.payload as { sessionId?: string }).sessionId).toBe(sid)
    expect((msg.payload as { entries: unknown[] }).entries).toEqual([deltaEntry])
    expect((msg.payload as { leafId: string }).leafId).toBe('delta-1')
    // since 用的是基线 leafId（非 undefined 全量）
    expect(client.getEntries).toHaveBeenLastCalledWith(recorded.data.leafId)

    // 基线滚动：下次触发用新 leafId
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'delta-1' } })
    svc.syncTraceEntries(sid, 'agent_settled')
    await vi.waitFor(() => expect(client.getEntries).toHaveBeenLastCalledWith('delta-1'))
    // 空 delta 不广播（追赶式拉取的正常稳态）
    await new Promise((r) => setTimeout(r, 20))
    expect(publishSpy).toHaveBeenCalledTimes(1)
    void bus
  })

  it('无基线（trace 视图未打开过）→ 增量腿 no-op，不发 RPC 不广播', () => {
    const { svc, publishSpy, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    svc.syncTraceEntries(fixtureSessionId('get-entries-1-mixed-kinds'), 'message_end')
    expect(client.getEntries).not.toHaveBeenCalled()
    expect(publishSpy).not.toHaveBeenCalled()
  })

  it('空 session 基线哨兵（review round1 MUST_FIX）：leafId=null 也建立基线——sync 无参全量拉不抛错；首条 entry 后 sync 全量拉并广播 + 基线推进真实 leaf', async () => {
    // 场景：新 session 发首条消息前打开 Trace 视图（pi _buildIndex 对仅 header 的 session
    // 置 leafId=null）。修复前基线不写 → doSyncTraceEntries 恒 no-op，台账冻结空态无恢复出口
    const { svc, publishSpy, client } = makeEnv({ active: true })
    const sid = 'empty-baseline-session'

    // 打开 trace 视图：空 session（无落盘文件、无 entry），pi 返回 leafId=null
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: null } })
    const snapshot = await svc.getTraceEntries(sid)
    expect(snapshot.source).toBe('rpc')
    expect(snapshot.leafId).toBeNull()

    // 空 session 的 sync：'' 哨兵基线 → 无参全量拉（'' 不下传 pi 当 since），delta 空 =
    // 正常稳态——不抛错、不广播
    client.getEntries.mockClear()
    svc.syncTraceEntries(sid, 'message_end')
    await vi.waitFor(() => expect(client.getEntries).toHaveBeenCalledTimes(1))
    expect(client.getEntries).toHaveBeenLastCalledWith()
    await new Promise((r) => setTimeout(r, 20))
    expect(publishSpy).not.toHaveBeenCalled()

    // session 写入首条 entry 后：sync 无参全量拉 → delta 即全部 entry → 广播 + 基线推进
    const firstEntry = { type: 'message', id: 'first-1', parentId: null, message: { role: 'user', content: 'hello' } }
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return { data: { entries: [firstEntry], leafId: 'first-1' } }
      return { data: { entries: [], leafId: 'first-1' } }
    })
    svc.syncTraceEntries(sid, 'message_end')
    await vi.waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1))
    const [pubSid, msg] = publishSpy.mock.calls[0] as [string, ServerMessage]
    expect(pubSid).toBe(sid)
    expect(msg.type).toBe('session.traceEntryAppended')
    // 规则 7：增量推送必带 sessionId；delta = 全部 entry（消费端按 entry.id 去重）
    expect((msg.payload as { sessionId?: string }).sessionId).toBe(sid)
    expect((msg.payload as { entries: unknown[] }).entries).toEqual([firstEntry])
    expect((msg.payload as { leafId: string }).leafId).toBe('first-1')

    // 基线已推进为真实 leaf：下次触发走 since 增量（不再无参全量）
    svc.syncTraceEntries(sid, 'agent_settled')
    await vi.waitFor(() => expect(client.getEntries).toHaveBeenLastCalledWith('first-1'))
    await new Promise((r) => setTimeout(r, 20))
    expect(publishSpy).toHaveBeenCalledTimes(1) // 空 delta 不重复广播
  })

  it('burst 合并：连发两个触发 → 串行链第二次 since 已是新 leaf → 空 delta 只广播一次', async () => {
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const { svc, publishSpy, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    client.getEntries.mockResolvedValue(recorded)
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')
    await svc.getTraceEntries(sid)
    publishSpy.mockClear()

    const deltaEntry = { type: 'message', id: 'd-1', parentId: recorded.data.leafId, message: { role: 'assistant', content: 'x' } }
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return recorded
      if (since === recorded.data.leafId) return { data: { entries: [deltaEntry], leafId: 'd-1' } }
      return { data: { entries: [], leafId: 'd-1' } }
    })
    // message_end 与 agent_settled 几乎同时到达（pi 常态时序）
    svc.syncTraceEntries(sid, 'message_end')
    svc.syncTraceEntries(sid, 'agent_settled')

    await vi.waitFor(() => expect(client.getEntries).toHaveBeenCalledTimes(3)) // 1 全量 + 2 增量
    await new Promise((r) => setTimeout(r, 20))
    expect(publishSpy).toHaveBeenCalledTimes(1) // 第二次空 delta 不重复广播
  })

  it('lifecycle RPC 补拉：switchModel 成功后主动触发（set_model 无 append 事件，design D4）', async () => {
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const { svc, publishSpy, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    client.getEntries.mockResolvedValue(recorded)
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')
    await svc.initializeManagedSession(sid, client as unknown as IPiEngine, '/tmp', 'test')
    await svc.getTraceEntries(sid)
    publishSpy.mockClear()

    const modelChangeEntry = { type: 'model_change', id: 'mc-x', parentId: recorded.data.leafId, provider: 'p', modelId: 'm' }
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return recorded
      return { data: { entries: [modelChangeEntry], leafId: 'mc-x' } }
    })
    await svc.switchModel(sid, 'test-provider' as never, 'test-model')

    // switchModel 先广播 session.state_changed（模型切换主流程），补拉链在其后 ——
    // 按 type 检出 traceEntryAppended，不依赖 publish 顺序
    await vi.waitFor(() => {
      expect(publishSpy.mock.calls.some((c) => (c[1] as ServerMessage).type === 'session.traceEntryAppended')).toBe(true)
    })
    const msg = publishSpy.mock.calls.map((c) => c[1] as ServerMessage).find((m) => m.type === 'session.traceEntryAppended') as ServerMessage
    expect((msg.payload as { sessionId: string }).sessionId).toBe(sid)
    expect((msg.payload as { entries: unknown[] }).entries).toEqual([modelChangeEntry])
  })

  it('lifecycle RPC 补拉：setThinkingLevel 成功后主动触发', async () => {
    const recorded = loadRecorded('get-entries-1-mixed-kinds')
    const { svc, publishSpy, client } = makeEnv({ metas: [metaFor('get-entries-1-mixed-kinds')], active: true })
    client.getEntries.mockResolvedValue(recorded)
    const sid = fixtureSessionId('get-entries-1-mixed-kinds')
    await svc.initializeManagedSession(sid, client as unknown as IPiEngine, '/tmp', 'test')
    await svc.getTraceEntries(sid)
    publishSpy.mockClear()

    const tlEntry = { type: 'thinking_level_change', id: 'tl-x', parentId: recorded.data.leafId, thinkingLevel: 'high' }
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since === undefined) return recorded
      return { data: { entries: [tlEntry], leafId: 'tl-x' } }
    })
    await svc.setThinkingLevel(sid, 'high')

    await vi.waitFor(() => {
      expect(publishSpy.mock.calls.some((c) => (c[1] as ServerMessage).type === 'session.traceEntryAppended')).toBe(true)
    })
    const msg = publishSpy.mock.calls.map((c) => c[1] as ServerMessage).find((m) => m.type === 'session.traceEntryAppended') as ServerMessage
    expect(msg.type).toBe('session.traceEntryAppended')
    expect((msg.payload as { sessionId: string }).sessionId).toBe(sid)
  })
})
