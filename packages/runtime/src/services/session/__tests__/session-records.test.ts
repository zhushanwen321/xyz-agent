/**
 * SessionRecords 直测（S6 迁出批 1）：subagent/workflow 记录域——派生缓存族（订阅注册/
 * 防抖失效/增量拉取/游标自愈/销毁清理）+ 动作命令转发 + 引擎配置读写。
 *
 * 分层（G2：import 无 session-service，stub 面 = deps 5 方法）：
 * - mock 层 = deps（pm/sessionStore/hasSession/getMessageBus/getExtensionPaths），entry
 *   形态对齐 pi appendCustomEntry 契约（沿用 session-record-entries.test.ts 的 fixture
 *   形态）；scanSubagentEntries/scanWorkflowEntries 等 extractor 生产代码真实执行。
 * - fake timers（项目规范）：SCALAR_STATE_DEBOUNCE_MS 防抖由 advanceTimersByTimeAsync 推进。
 * - 引擎配置组：vi.mock pi-paths 的 getPiAgentDir 指向 per-test 临时目录（其余导出
 *   importOriginal 保留），withFileLockSync/atomicWrite 真实执行。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import type { SessionRecordsDeps } from '../session-records.js'
import { SessionRecords, encodeDirectiveText } from '../session-records.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'

/** 引擎配置组的 getPiAgentDir 重定向目标（hoisted：vi.mock 工厂内引用）。 */
const piAgentDirRef = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => piAgentDirRef.dir }
})

/** get_entries RPC 返回形态（pi GetEntriesResponse：{entries, leafId}）。 */
type GetEntriesResult = { data?: { entries?: unknown[]; leafId?: string | null } }

/** 自描述 subagent-record entry（W16 v1 完整快照）。 */
function subagentRecordEntry(id: string, status: string, entryId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'subagent-record',
    id: entryId,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 1,
      id,
      agent: 'worker',
      task: 'Do work',
      slug: 'work',
      status,
      startedAt: 1000,
      ...extra,
    },
  }
}

/** 自描述 workflow-record entry（W17 v1：{v:1, snapshot, updatedAt}）。 */
function workflowRecordEntry(runId: string, status: 'running' | 'done', entryId: string, reason?: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'workflow-record',
    id: entryId,
    parentId: null,
    timestamp: '2026-08-19T00:00:00Z',
    data: {
      v: 1,
      updatedAt: '2026-08-19T00:00:01Z',
      snapshot: {
        v: 'wf-run-v2',
        runId,
        spec: { scriptName: 'test-flow' },
        state: { status, reason, budget: { usedTokens: 1, usedCost: 0 }, calls: [], trace: [] },
        meta: { startedAt: '2026-08-19T00:00:00Z' },
      },
    },
  }
}

/** 最小装置：deps 全 mock（publish spy 收集 bus 发布；client 可编程）。 */
function makeRecords(depsOverrides: Partial<SessionRecordsDeps> = {}) {
  const publish = vi.fn()
  const client = {
    getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [], leafId: null } }) as GetEntriesResult),
    prompt: vi.fn(async (_text: string) => undefined),
  }
  const deps: SessionRecordsDeps = {
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore: { scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>) } as unknown as ISessionStore,
    hasSession: vi.fn(() => true),
    getMessageBus: () => ({ publish } as unknown as IMessageBus),
    getExtensionPaths: vi.fn(async () => [] as string[]),
    ...depsOverrides,
  }
  const records = new SessionRecords(deps)
  return { records, publish, client, deps }
}

/** subscribe 后收集注册 handler，返回手动触发器（模拟 lifecycle 同步直发）。 */
function registerSession(records: SessionRecords): (sessionId: string) => void {
  const handlers: Array<(sessionId: string) => void> = []
  records.subscribe({ onSessionRegistered: (h) => { handlers.push(h) } })
  return (sessionId: string) => { for (const h of handlers) h(sessionId) }
}

/** 推进防抖并等待在途拉取落定。 */
async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
}

describe('订阅与缓存注册', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('subscribe 注册 handler：触发后缓存就位，失效可拉取', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('未注册 session 的失效 no-op（冷启动走磁盘路径）', async () => {
    const { records, client } = makeRecords()
    records.invalidateRecordEntries('s-unknown', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('invalidateRecordEntries：防抖', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('防抖窗口内多次失效合并为一次拉取', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    records.invalidateRecordEntries('s1', 'workflow-record')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('非 record customType 忽略（entry_appended 主信号的其他 custom entry）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'other-custom-type')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('refreshRecordEntries：拉取与发布', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('全量路径：有变化才发布 session.subagents 全量帧与 session.workflowUpdate 增量信号', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({
      data: {
        entries: [
          subagentRecordEntry('sa-1', 'running', 'e1'),
          workflowRecordEntry('run-1', 'running', 'e2'),
        ],
        leafId: 'e2',
      },
    })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()

    const subagentsMsg = publish.mock.calls.find(([, msg]) => (msg as { type: string }).type === 'session.subagents')
    expect(subagentsMsg).toBeDefined()
    expect(subagentsMsg![0]).toBe('s1')
    expect((subagentsMsg![1] as { payload: { subagents: Array<{ subagentId: string; status: string }> } }).payload.subagents)
      .toEqual([expect.objectContaining({ subagentId: 'sa-1', status: 'running' })])

    const workflowMsgs = publish.mock.calls.filter(([, msg]) => (msg as { type: string }).type === 'session.workflowUpdate')
    expect(workflowMsgs).toHaveLength(1)
    expect((workflowMsgs[0][1] as { payload: { update: { runId: string; status: string } } }).payload.update)
      .toEqual({ runId: 'run-1', status: 'running', reason: undefined })
  })

  it('同值重复 entry 不重复发布（diff 基线）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    const entry = subagentRecordEntry('sa-1', 'running', 'e1')
    client.getEntries.mockResolvedValue({ data: { entries: [entry], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)

    // 增量窗口返回同值新 entry（快照未变）——不发布
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e9')], leafId: 'e9' } })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('增量路径：cursor 建立后失效走 getEntries(since)', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()

    client.getEntries.mockClear()
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'done', 'e2')], leafId: 'e2' } })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
    const subagentsMsgs = publish.mock.calls.filter(([, msg]) => (msg as { type: string }).type === 'session.subagents')
    expect(subagentsMsgs).toHaveLength(2) // 第一轮全量 + 增量变化各一帧
    expect((subagentsMsgs.at(-1)![1] as { payload: { subagents: Array<{ status: string }> } }).payload.subagents[0].status).toBe('done')
  })

  it('游标失效自愈：Entry not found → 丢 cursor 第二轮全量重建', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()

    // since 拉取报 Entry not found → 同一次 refresh 内丢 cursor 全量重拉
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) throw new Error('Entry not found: e1')
      return { data: { entries: [subagentRecordEntry('sa-1', 'done', 'e5')], leafId: 'e5' } } as GetEntriesResult
    })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
    expect(client.getEntries).toHaveBeenCalledWith()
    // 自愈重建后的状态经发布可见（取最后一帧——第一轮全量已发过 running 帧）
    const subagentsMsgs = publish.mock.calls.filter(([, msg]) => (msg as { type: string }).type === 'session.subagents')
    expect((subagentsMsgs.at(-1)![1] as { payload: { subagents: Array<{ status: string }> } }).payload.subagents[0].status).toBe('done')
  })

  it('其他 RPC 错误：不发布、cursor 保留（下次重试仍走增量）', async () => {
    const { records, publish, client } = makeRecords()
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    publish.mockClear()

    client.getEntries.mockRejectedValue(new Error('rpc timeout'))
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).not.toHaveBeenCalled()

    // 恢复后重试：仍带原 cursor（未被丢弃）
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: 'e1' } })
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).toHaveBeenCalledWith('e1')
  })

  it('inflight 共享：拉取在途时的新失效复用同一 promise', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    let release!: (v: GetEntriesResult) => void
    client.getEntries.mockImplementation(async () => new Promise<GetEntriesResult>((resolve) => { release = resolve }))
    records.invalidateRecordEntries('s1', 'subagent-record')
    // 同步推进：防抖到期 → refresh 同步段启动（inflight 已设，getEntries 挂起）
    vi.advanceTimersByTime(SCALAR_STATE_DEBOUNCE_MS)
    // 拉取在途：新失效 → 新防抖 → 到期后 refresh 复用 inflight（不重复 RPC）
    records.invalidateRecordEntries('s1', 'subagent-record')
    vi.advanceTimersByTime(SCALAR_STATE_DEBOUNCE_MS)
    release({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(client.getEntries).toHaveBeenCalledTimes(1)
  })

  it('session 已销毁守卫：hasSession false 时 merge 但不 publish', async () => {
    const { records, publish, client } = makeRecords({ hasSession: vi.fn(() => false) })
    const fire = registerSession(records)
    client.getEntries.mockResolvedValue({ data: { entries: [subagentRecordEntry('sa-1', 'running', 'e1')], leafId: 'e1' } })
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(publish).not.toHaveBeenCalled()
  })

  it('client 不存在（session 已死）：拉取冻结 no-op', async () => {
    const { records, client } = makeRecords({ pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager })
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })
})

describe('onSessionDisposed', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('清缓存并停防抖定时器（pending 防抖到期后不拉取）', async () => {
    const { records, client } = makeRecords()
    const fire = registerSession(records)
    fire('s1')
    records.invalidateRecordEntries('s1', 'subagent-record')
    records.onSessionDisposed('s1')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
    // 缓存条目已删：后续失效 no-op
    records.invalidateRecordEntries('s1', 'subagent-record')
    await flushDebounce()
    expect(client.getEntries).not.toHaveBeenCalled()
  })

  it('未注册 session 的 dispose 幂等 no-op', () => {
    const { records } = makeRecords()
    expect(() => records.onSessionDisposed('s-none')).not.toThrow()
  })
})

describe('磁盘读侧（scanSessions → extractor 真实执行）', () => {
  it('getSubagents：定位 session 文件后经 extractor 提取 record 列表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, JSON.stringify(subagentRecordEntry('sa-1', 'running', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    const result = await records.getSubagents('s1')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(expect.objectContaining({ subagentId: 'sa-1', status: 'running' }))
  })

  it('getSubagents：session 不在扫描结果返回 []', async () => {
    const { records } = makeRecords()
    expect(await records.getSubagents('s-none')).toEqual([])
  })

  it('getWorkflows：定位 session 文件后提取 workflow 列表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, JSON.stringify(workflowRecordEntry('run-1', 'done', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    const result = await records.getWorkflows('s1')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(expect.objectContaining({ runId: 'run-1', status: 'done' }))
  })
})

describe('getSubagentHistory / getAgentCallFilePath：负路径守卫', () => {
  beforeEach(() => { piAgentDirRef.dir = mkdtempSync(join(tmpdir(), 'session-records-piagent-')) })
  afterEach(() => { piAgentDirRef.dir = '' })

  it('record 不存在返回 []', async () => {
    const { records } = makeRecords()
    expect(await records.getSubagentHistory('s1', 'sa-none')).toEqual([])
  })

  it('路径穿越守卫：sessionFile 逃出 piAgentDir 的 record 历史返回 []', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, JSON.stringify(subagentRecordEntry('sa-1', 'running', 'e1', { sessionFile: '/etc/passwd' })))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    expect(await records.getSubagentHistory('s1', 'sa-1')).toEqual([])
    expect(await records.getAgentCallFilePath('s1', 'sa-1')).toBe('')
  })

  it('getAgentCallFilePath：record 无 sessionFile 返回空串（UI 隐藏按钮契约）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-records-test-'))
    const filePath = join(dir, 'session.jsonl')
    writeFileSync(filePath, JSON.stringify(subagentRecordEntry('sa-1', 'running', 'e1')))
    const { records } = makeRecords({
      sessionStore: { scanSessions: vi.fn(() => [{ id: 's1', filePath }]) } as unknown as ISessionStore,
    })
    expect(await records.getAgentCallFilePath('s1', 'sa-1')).toBe('')
  })

  it('getAgentCallHistory：agent call 即 subagent，委托 getSubagentHistory 路径', async () => {
    const { records } = makeRecords()
    expect(await records.getAgentCallHistory('s1', 'sa-none')).toEqual([])
  })
})

describe('workflowAction / subagentAction：命令转发', () => {
  it('workflowAction 转发 /workflows <action> <runId> 到活跃 client', async () => {
    const { records, client } = makeRecords()
    await records.workflowAction('s1', 'pause', 'run-1')
    expect(client.prompt).toHaveBeenCalledWith('/workflows pause run-1')
  })

  it('workflowAction：session 不活跃 throw', async () => {
    const { records } = makeRecords({ pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager })
    await expect(records.workflowAction('s1', 'pause', 'run-1')).rejects.toThrow('Session s1 not active')
  })

  it('subagentAction cancel 转发 /subagents cancel <subagentId>', async () => {
    const { records, client } = makeRecords()
    await records.subagentAction('s1', 'cancel', { subagentId: 'sa-1' })
    expect(client.prompt).toHaveBeenCalledWith('/subagents cancel sa-1')
  })

  it('subagentAction message：换行经 encodeDirectiveText 编码保持命令单行', async () => {
    const { records, client } = makeRecords()
    await records.subagentAction('s1', 'message', { subagentId: 'sa-1', text: 'line1\nline2\\end' })
    expect(client.prompt).toHaveBeenCalledWith(`/subagents message sa-1 ${encodeDirectiveText('line1\nline2\\end')}`)
    const sent = (client.prompt as unknown as { mock: { calls: string[][] } }).mock.calls[0][0] as string
    expect(sent.includes('\n')).toBe(false)
  })

  it('subagentAction start 转发 /subagents start <slug> <task>', async () => {
    const { records, client } = makeRecords()
    await records.subagentAction('s1', 'start', { slug: 'worker', task: 'Do work' })
    expect(client.prompt).toHaveBeenCalledWith('/subagents start worker Do work')
  })

  it.each([
    ['cancel 缺 subagentId', 'cancel', {} as Record<string, string>, 'subagentId is required'],
    ['message 缺 text', 'message', { subagentId: 'sa-1' }, 'subagentId and text are required'],
    ['start 缺 slug', 'start', { task: 't' }, 'slug and task are required'],
  ])('协议错误 fail-fast：%s', async (_label, action, params, expected) => {
    const { records } = makeRecords()
    await expect(records.subagentAction('s1', action as 'cancel', params)).rejects.toThrow(expected)
  })

  it('subagentAction：session 不活跃 throw', async () => {
    const { records } = makeRecords({ pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager })
    await expect(records.subagentAction('s1', 'cancel', { subagentId: 'sa-1' })).rejects.toThrow('Session s1 not active')
  })
})

describe('引擎配置（getPiAgentDir 重定向临时目录，锁与原子写真实执行）', () => {
  beforeEach(() => {
    piAgentDirRef.dir = mkdtempSync(join(tmpdir(), 'session-records-engines-'))
    mkdirSync(join(piAgentDirRef.dir, 'subagents'), { recursive: true })
  })
  afterEach(() => { piAgentDirRef.dir = '' })

  it('engines.json + config.json 读取：返回动态清单与默认引擎', async () => {
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'engines.json'), JSON.stringify({ engines: ['pi', 'codex'] }))
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'config.json'), JSON.stringify({ defaultEngine: 'codex' }))
    const { records } = makeRecords()
    expect(await records.getSubagentEngineConfig()).toEqual({ engines: ['pi', 'codex'], defaultEngine: 'codex' })
  })

  it('engines.json 缺失：经扩展路径静态声明回退（U7b）', async () => {
    const swDir = join(piAgentDirRef.dir, 'sw', 'subagent-workflow')
    mkdirSync(swDir, { recursive: true })
    writeFileSync(join(swDir, 'package.json'), JSON.stringify({ name: 'sw', xyzAgent: 1, 'xyz-agent': { subagentEngines: ['pi', 'custom'] } }))
    const { records } = makeRecords({ getExtensionPaths: vi.fn(async () => [swDir]) })
    expect(await records.getSubagentEngineConfig()).toEqual({ engines: ['pi', 'custom'], defaultEngine: 'pi' })
  })

  it('静态声明回退也失败：兜底 [pi]（pi 恒可用）', async () => {
    const { records } = makeRecords({ getExtensionPaths: vi.fn(async () => { throw new Error('ext service down') }) })
    expect(await records.getSubagentEngineConfig()).toEqual({ engines: ['pi'], defaultEngine: 'pi' })
  })

  it('setSubagentDefaultEngine：未知引擎 throw（GUI 端防呆）', async () => {
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'engines.json'), JSON.stringify({ engines: ['pi'] }))
    const { records } = makeRecords()
    await expect(records.setSubagentDefaultEngine('unknown-engine')).rejects.toThrow("unknown subagent engine 'unknown-engine'")
  })

  it('setSubagentDefaultEngine：清单内引擎写入 config.json 且保留其他字段', async () => {
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'engines.json'), JSON.stringify({ engines: ['pi', 'codex'] }))
    writeFileSync(join(piAgentDirRef.dir, 'subagents', 'config.json'), JSON.stringify({ defaultEngine: 'pi', other: 'kept' }))
    const { records } = makeRecords()
    await records.setSubagentDefaultEngine('codex')
    const written = JSON.parse(readFileSync(join(piAgentDirRef.dir, 'subagents', 'config.json'), 'utf8')) as Record<string, unknown>
    expect(written.defaultEngine).toBe('codex')
    expect(written.other).toBe('kept')
  })
})
