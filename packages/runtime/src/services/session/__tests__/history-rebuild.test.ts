/**
 * SessionHistoryReader 直测（S6 迁出批 2）：history 域读编排——getHistory 三分支重建
 * （缓存增量 / RPC 全量 / 尾读降级）+ parentId 不变量 + Entry-not-found 自愈 +
 * inflight 合并 + getFullHistory 文件直读 + onSessionDisposed 清理。
 *
 * 分层（G2：import 无 session-service，stub 面 = deps 2 方法 + session-history 模块）：
 * - mock 层 = deps（pm.getClient / sessionStore.rebuild/scan）与 session-history 的
 *   尾读/全量文件读；三分支编排、LRU 缓存、mergeIncrementalMessages 去重等生产逻辑真实执行。
 * - entry→Message 转换链（rebuildHistoryFromEntries）由 session-history 域自身测试覆盖，
 *   此处以可编程 mock 替换，断言集中在编排分支选择与缓存状态迁移。
 */
import { describe, it, expect, vi } from 'vitest'
import type { Message } from '@xyz-agent/shared'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import { getHistoryTailFromFile, getHistoryFromFilePath } from '../../session-history.js'
import { SessionHistoryReader } from '../history-rebuild-cache.js'

vi.mock('../../session-history.js', () => ({
  getHistoryFromFilePath: vi.fn(async () => [{ id: 'full-1', role: 'user', content: 'full', status: 'complete', timestamp: 1 } as Message]),
  getHistoryTailFromFile: vi.fn(async () => ({ messages: [{ id: 'tail-1', role: 'user', content: 'tail', status: 'complete', timestamp: 1 } as Message], truncated: true })),
}))

/** pi entry 最小形态（编排只消费 parentId / 传给 rebuild mock）。 */
function entry(id: string, parentId: string | null): Record<string, unknown> {
  return { type: 'message', id, parentId, timestamp: '2026-08-19T00:00:00Z' }
}

function msg(id: string, piEntryId?: string): Message {
  return { id, role: 'user', content: `content-${id}`, status: 'complete', timestamp: 1, piEntryId } as Message
}

/** get_entries RPC 返回形态（pi GetEntriesResponse：{entries, leafId}）。 */
type GetEntriesResult = { data?: { entries?: Array<Record<string, unknown>>; leafId?: string | null } }

function makeReader(rebuildImpl?: (entries: Array<Record<string, unknown>>) => Message[]) {
  const client = {
    getEntries: vi.fn(async (_since?: string) => ({ data: { entries: [], leafId: null } }) as GetEntriesResult),
  }
  const rebuild = vi.fn((entries: Array<Record<string, unknown>>): { messages: Message[]; orphanToolResults: [] } => ({
    // 缺省实现：每 entry 产一条消息，piEntryId = entry.id
    messages: (rebuildImpl ?? ((es) => es.map((e) => msg(`m-${String(e.id)}`, String(e.id)))))(entries),
    orphanToolResults: [],
  }))
  const sessionStore = {
    scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>),
    rebuildHistoryFromEntries: rebuild,
  } as unknown as ISessionStore
  const reader = new SessionHistoryReader({
    pm: { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager,
    sessionStore,
  })
  return { reader, client, rebuild, sessionStore }
}

describe('分支 3：全量重建（无缓存）', () => {
  it('client 活跃：getEntries 全量 → rebuild → 写缓存并返回浅拷贝', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValue({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    const result = await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenCalledWith()
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1'])
    expect(result.truncated).toBe(false)
    // 返回浅拷贝：就地 push 不打穿缓存基底
    result.messages.push(msg('intruder'))
    const again = await reader.getHistory('s1')
    // 第二次走缓存增量（空增量 = 新鲜短路），内容仍是原两条基线 + 无 intruder
    expect(again.messages.some((m) => m.id === 'intruder')).toBe(false)
  })

  it('R-12：RPC entries 空 → 短路返回空列表（不走尾读）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValue({ data: { entries: [], leafId: null } })
    const result = await reader.getHistory('s1')
    expect(result).toEqual({ messages: [], truncated: false })
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
  })
})

describe('分支 1/2：缓存命中 → since 增量', () => {
  it('空增量 = 缓存新鲜：R-12 短路返回缓存，零重建零尾读', async () => {
    const { reader, client, rebuild } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null), entry('e2', 'e1')], leafId: 'e2' } })
    await reader.getHistory('s1') // 建缓存
    client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: 'e2' } })
    const result = await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenLastCalledWith('e2')
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1', 'm-e2'])
    expect(rebuild).toHaveBeenCalledTimes(1) // 增量窗口未重建
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
  })

  it('增量非空且 parentId 不变量成立：merge 合并入缓存并推进 leafId', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e2', 'e1')], leafId: 'e2' } })
    const result = await reader.getHistory('s1')
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1', 'm-e2'])
    expect(result.truncated).toBe(false)
    // 缓存已推进：下次增量以新 leafId 为 since
    client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: 'e2' } })
    await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenLastCalledWith('e2')
  })

  it('增量消息与缓存 piEntryId 重复时去重（D6-3，mergeIncrementalMessages 真跑）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null), entry('e2', 'e1')], leafId: 'e2' } })
    await reader.getHistory('s1')
    // 增量窗口首条 parent 匹配缓存 leafId，窗口尾部混入已缓存的 e2（pi slice 异常时序防御）
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e3', 'e2'), entry('e2', 'e1')], leafId: 'e3' } })
    const result = await reader.getHistory('s1')
    expect(result.messages.map((m) => m.id)).toEqual(['m-e1', 'm-e2', 'm-e3'])
  })

  it('parentId 不变量违反（branch/rewrite）：丢缓存 fall-through 全量重建', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    // delta 首条 parent ≠ 缓存 leafId → 丢缓存 → 同次调用内全量重建
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) return { data: { entries: [entry('branch-head', 'old-point')], leafId: 'branch-head' } } as GetEntriesResult
      return { data: { entries: [entry('r1', null), entry('r2', 'r1')], leafId: 'r2' } } as GetEntriesResult
    })
    const result = await reader.getHistory('s1')
    expect(result.messages.map((m) => m.id)).toEqual(['m-r1', 'm-r2'])
    expect(client.getEntries).toHaveBeenCalledWith()
  })

  it('增量 Entry not found：丢缓存 → 全量重拉（D6-4 自愈）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    client.getEntries.mockImplementation(async (since?: string) => {
      if (since !== undefined) throw new Error('Entry not found: e1')
      return { data: { entries: [entry('f1', null)], leafId: 'f1' } } as GetEntriesResult
    })
    const result = await reader.getHistory('s1')
    expect(result.messages.map((m) => m.id)).toEqual(['m-f1'])
  })

  it('增量其他错误：尾读降级 + 缓存保留（下次重试仍走 since）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValueOnce({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    client.getEntries.mockRejectedValueOnce(new Error('rpc timeout'))
    const degraded = await reader.getHistory('s1')
    expect(degraded.truncated).toBe(true)
    expect(degraded.messages.map((m) => m.id)).toEqual(['tail-1'])
    // 缓存未被丢弃：恢复后重试走 since
    client.getEntries.mockResolvedValueOnce({ data: { entries: [], leafId: 'e1' } })
    const retry = await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenLastCalledWith('e1')
    expect(retry.truncated).toBe(false)
  })
})

describe('无 client（离线 session）与全量文件读', () => {
  it('无 RPC client：直接尾读降级（不读不写缓存）', async () => {
    const reader = new SessionHistoryReader({
      pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
      sessionStore: {} as unknown as ISessionStore,
    })
    const result = await reader.getHistory('s1')
    expect(result.truncated).toBe(true)
    expect(getHistoryTailFromFile).toHaveBeenCalled()
  })

  it('getFullHistory：scanSessions 命中 → 全量文件读（force 旁路 TTL）', async () => {
    const { reader, sessionStore } = makeReader()
    ;(sessionStore.scanSessions as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0
    ;(sessionStore.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([{ id: 's1', filePath: '/tmp/s1.jsonl' }])
    const result = await reader.getFullHistory('s1')
    expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true })
    expect(result.map((m) => m.id)).toEqual(['full-1'])
    expect(getHistoryFromFilePath).toHaveBeenCalledWith('/tmp/s1.jsonl', sessionStore)
  })

  it('getFullHistory：session 不在扫描结果 → []', async () => {
    const { reader } = makeReader()
    expect(await reader.getFullHistory('s-none')).toEqual([])
  })
})

describe('inflight 合并与 onSessionDisposed', () => {
  it('并发 getHistory 同 session 共享一次 RPC（W20 Fix-5）', async () => {
    const { reader, client } = makeReader()
    let release!: (v: GetEntriesResult) => void
    client.getEntries.mockImplementation(async () => new Promise<GetEntriesResult>((resolve) => { release = resolve }))
    const p1 = reader.getHistory('s1')
    const p2 = reader.getHistory('s1')
    release({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(client.getEntries).toHaveBeenCalledTimes(1)
    expect(r1).toEqual(r2)
  })

  it('onSessionDisposed：清缓存（后续 getHistory 走全量而非增量）', async () => {
    const { reader, client } = makeReader()
    client.getEntries.mockResolvedValue({ data: { entries: [entry('e1', null)], leafId: 'e1' } })
    await reader.getHistory('s1')
    reader.onSessionDisposed('s1')
    client.getEntries.mockClear()
    await reader.getHistory('s1')
    expect(client.getEntries).toHaveBeenCalledWith() // 无缓存 → 全量（无参调用）
  })

  it('onSessionDisposed：未缓存 session 幂等 no-op', () => {
    const { reader } = makeReader()
    expect(() => reader.onSessionDisposed('s-none')).not.toThrow()
  })
})
