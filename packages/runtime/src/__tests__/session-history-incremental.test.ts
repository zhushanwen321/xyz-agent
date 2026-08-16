/**
 * D6 历史增量 + 重建缓存测试（wave:perf-w20）。
 *
 * 覆盖（plan.md W20 验收）：
 * 1. 增量路径——第二次 getHistory 带 since 且返回增量条目 < 全量
 * 2. 空 entries 短路（R-12：不走尾读 fallback，直接返回缓存/空列表）
 * 3. "Entry not found" fallback 全量重拉（D6-4）+ 其他错误走尾读且缓存不动
 * 4. lastLeafId 随成功 getHistory 更新、removeSessionEntry（pi 退出汇聚点）清除
 * 5. HistoryRebuildCache LRU 容量帽 + mergeIncrementalMessages piEntryId 去重
 *
 * mock 分层：
 * - client.getEntries：按调用序列返回真实响应形状 {data: {entries, leafId}}；
 *   "Entry not found" 走真实 reject 路径（new Error(msg.error)，与 rpc-client 一致）
 * - sessionStore.rebuildHistoryFromEntries：直通 mock（entry.id → piEntryId），
 *   只测 getHistory 的分支编排（since 传递/短路/fallback/缓存生命周期）
 * - getHistoryTailFromFile：模块级 spy（断言「不走尾读」的唯一可信证据）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-history-incremental.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { PiSessionEntry } from '../infra/pi/pi-protocol.js'

// spy 尾读 fallback（「不走尾读」的判定依据）
vi.mock('../services/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/session-history.js')>()
  return {
    ...actual,
    getHistoryTailFromFile: vi.fn(async () => ({ messages: [], truncated: true })),
  }
})
const { getHistoryTailFromFile } = await import('../services/session-history.js')

// SUT 在 vi.mock 之后 import（session-service 内部引用 mocked 模块）
const { SessionService } = await import('../services/session/session-service.js')
const { HistoryRebuildCache, mergeIncrementalMessages } = await import('../services/session/history-rebuild-cache.js')

/** 最小 PiSessionEntry（rebuildHistoryFromEntries 是直通 mock，只消费 id）。 */
function entry(id: string): PiSessionEntry {
  return { id, type: 'message', parentId: null, timestamp: '2026-08-16T00:00:00.000Z' } as unknown as PiSessionEntry
}

function msg(piEntryId: string) {
  return {
    id: `m-${piEntryId}`,
    role: 'user' as const,
    content: `content-${piEntryId}`,
    status: 'complete' as const,
    piEntryId,
    timestamp: 1,
  }
}

interface GetEntriesCall {
  since?: string
}

/**
 * 构造 SessionService + 可编排的 getEntries mock。
 * getEntriesScript 按调用序出队：每项是 {data} 成功响应或 Error（reject）。
 * 每次调用记录 since 参数（断言增量路径的传递）。
 */
function makeService(getEntriesScript: Array<{ data?: { entries: PiSessionEntry[]; leafId: string | null } } | Error>) {
  const calls: GetEntriesCall[] = []
  const client = {
    getEntries: vi.fn(async (since?: string) => {
      calls.push({ since })
      const step = getEntriesScript.shift()
      if (step instanceof Error) throw step
      if (!step) throw new Error('getEntries script exhausted')
      return step
    }),
  } as unknown as IPiEngine

  const broker = { broadcast: vi.fn((_m: ServerMessage) => {}) } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
  } as unknown as IProcessManager

  const sessionStore = {
    // 直通 mock：entry.id → Message.piEntryId（getHistory 的分支逻辑与重建实现解耦）
    rebuildHistoryFromEntries: vi.fn((entries: PiSessionEntry[]) => ({
      messages: entries.map((e) => msg(e.id)),
    })),
    scanSessions: vi.fn(() => []),
    extractSessionOutcome: vi.fn(() => null),
    persistSessionEnd: vi.fn(),
  } as never

  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
    '/test/project-root',
    {} as never,
    { getDefaultModel: () => null } as never,
    sessionStore,
    { pruneStaleCache: vi.fn() } as never,
    {} as never,
  )
  return { svc, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── 单元：HistoryRebuildCache（D6-1 容量帽 LRU）────────────────

describe('HistoryRebuildCache', () => {
  it('超容量帽驱逐最久未访问的 session 条目（帽 8，对齐 renderer LRU 窗口）', () => {
    const cache = new HistoryRebuildCache()
    const e = () => ({ leafId: `leaf-${Math.random()}`, messages: [], truncated: false })
    for (let i = 0; i < 10; i++) cache.set(`s-${i}`, e())
    expect(cache.size).toBe(8)
    // 最久的 s-0/s-1 被驱逐，最新的 s-2..s-9 保留
    expect(cache.get('s-0')).toBeUndefined()
    expect(cache.get('s-1')).toBeUndefined()
    expect(cache.get('s-9')).toBeDefined()
  })

  it('get 刷新 LRU 位置——访问过的条目不被后续超帽驱逐', () => {
    const cache = new HistoryRebuildCache(2)
    const e = () => ({ leafId: 'l', messages: [], truncated: false })
    cache.set('a', e())
    cache.set('b', e())
    cache.get('a') // a 移到最近使用
    cache.set('c', e()) // 超帽驱逐 b（最久未访问），a 保留
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })

  it('delete 清除指定 session 条目', () => {
    const cache = new HistoryRebuildCache()
    cache.set('s', { leafId: 'l', messages: [], truncated: false })
    cache.delete('s')
    expect(cache.get('s')).toBeUndefined()
  })
})

// ── 单元：mergeIncrementalMessages（D6-3 piEntryId 去重）────────

describe('mergeIncrementalMessages', () => {
  it('同 piEntryId 跳过（不重复），新 piEntryId 追加尾部', () => {
    const cached = [msg('e1'), msg('e2')]
    const incremental = [msg('e2'), msg('e3')] // e2 已在缓存（compact/异常时序的重复兜底）
    const merged = mergeIncrementalMessages(cached, incremental)
    expect(merged.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e3'])
    // 不修改入参
    expect(cached).toHaveLength(2)
    expect(incremental).toHaveLength(2)
  })

  it('无 piEntryId 的增量消息防御性追加（宁可重复不可丢消息）', () => {
    const cached = [msg('e1')]
    const noId = { id: 'm-x', role: 'user' as const, content: 'x', status: 'complete' as const, timestamp: 1 }
    const merged = mergeIncrementalMessages(cached, [noId])
    expect(merged).toHaveLength(2)
  })

  it('幂等：同批增量重复合并无副作用', () => {
    const cached = [msg('e1')]
    const inc = [msg('e2')]
    const once = mergeIncrementalMessages(cached, inc)
    const twice = mergeIncrementalMessages(once, inc)
    expect(twice.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
  })
})

// ── 集成：SessionService.getHistory 三分支（D6 + R-12 + D6-4）────

describe('SessionService.getHistory —— D6 历史增量', () => {
  it('① 首次全量（无 since）→ 第二次带 since 增量且增量条目 < 全量，合并后缓存更新', async () => {
    // 首次：全量 5 条，leafId=leaf-1；第二次：since 增量 2 条（<5），leafId=leaf-2
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1'), entry('e2'), entry('e3'), entry('e4'), entry('e5')], leafId: 'leaf-1' } },
      { data: { entries: [entry('e6'), entry('e7')], leafId: 'leaf-2' } },
    ])

    const first = await svc.getHistory('s1')
    expect(first.messages).toHaveLength(5)
    expect(first.truncated).toBe(false)
    expect(calls[0]?.since).toBeUndefined() // 首次全量无 since

    const second = await svc.getHistory('s1')
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'])
    expect(second.truncated).toBe(false)
    // 第二次带 since=上次 leafId（增量窗口 2 条 < 全量 5 条）
    expect(calls[1]?.since).toBe('leaf-1')
    expect(second.messages).toHaveLength(7) // 5 缓存 + 2 增量（piEntryId 去重合并）
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
  })

  it('② R-12：增量空 entries 短路——直接返回缓存，不走尾读 fallback，getEntries 只调一次', async () => {
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1'), entry('e2')], leafId: 'leaf-1' } },
      { data: { entries: [], leafId: 'leaf-1' } }, // 空增量 = leafId 未变 = 缓存新鲜
    ])

    await svc.getHistory('s2')
    const second = await svc.getHistory('s2')
    expect(second.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2'])
    expect(second.truncated).toBe(false)
    expect(calls[1]?.since).toBe('leaf-1')
    expect(getHistoryTailFromFile).not.toHaveBeenCalled() // R-12：短路，不走尾读
  })

  it('② R-12（全量侧）：无缓存 + pi 返回空 entries → 返回空列表，不走尾读', async () => {
    const { svc } = makeService([{ data: { entries: [], leafId: null } }])
    const result = await svc.getHistory('s3')
    expect(result).toEqual({ messages: [], truncated: false })
    expect(getHistoryTailFromFile).not.toHaveBeenCalled()
  })

  it('③ D6-4：增量 "Entry not found" → 丢缓存 → 全量重拉并覆盖缓存', async () => {
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1')], leafId: 'leaf-1' } },
      new Error('Entry not found: leaf-1'), // since 失效（防御场景：缓存跨 pi 进程存活）
      { data: { entries: [entry('e1'), entry('e2'), entry('e3')], leafId: 'leaf-3' } }, // 全量重拉
      { data: { entries: [entry('e4')], leafId: 'leaf-4' } }, // 验证缓存已被全量结果覆盖（新基线 leaf-3）
    ])

    await svc.getHistory('s4') // 全量 → 缓存 {leaf-1, [e1]}
    const afterFallback = await svc.getHistory('s4') // Entry not found → 全量重拉 → {leaf-3, [e1,e2,e3]}
    expect(afterFallback.messages.map((m) => m.piEntryId)).toEqual(['e1', 'e2', 'e3'])
    expect(calls[1]?.since).toBe('leaf-1')
    expect(calls[2]?.since).toBeUndefined() // fallback 是全量（无 since）
    expect(getHistoryTailFromFile).not.toHaveBeenCalled() // fallback 是全量重拉，不是尾读

    // 缓存基线已更新为 leaf-3：下次走 since=leaf-3 增量
    const third = await svc.getHistory('s4')
    expect(calls[3]?.since).toBe('leaf-3')
    expect(third.messages).toHaveLength(4)
  })

  it('其他错误（非 Entry not found）→ 尾读降级，缓存不动（下次重试仍走 since）', async () => {
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1')], leafId: 'leaf-1' } },
      new Error('RPC command "get_entries" timed out after 60000ms'),
      { data: { entries: [entry('e2')], leafId: 'leaf-2' } }, // 缓存未丢：仍以 leaf-1 为基线走增量
    ])

    await svc.getHistory('s5')
    const degraded = await svc.getHistory('s5')
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1) // 现状同链降级（尾读）
    expect(degraded.truncated).toBe(true) // 尾读路径的截断标志（mock 尾读返回 truncated:true）
    expect(calls[1]?.since).toBe('leaf-1')

    // 缓存未被尾读结果覆盖：下次 getHistory 仍走 since 增量（基线还是 leaf-1）
    await svc.getHistory('s5')
    expect(calls[2]?.since).toBe('leaf-1')
  })

  it('⑤ lastLeafId 生命周期：removeSessionEntry（session 删除/pi 退出汇聚点）清除缓存 → 下次全量', async () => {
    const { svc, calls } = makeService([
      { data: { entries: [entry('e1')], leafId: 'leaf-1' } },
      { data: { entries: [entry('e2')], leafId: 'leaf-2' } }, // 清除后的全量（脚本顺序：清后再 getHistory）
    ])

    await svc.getHistory('s6') // 全量 → 缓存 leaf-1
    expect(calls[0]?.since).toBeUndefined()

    svc.removeSessionEntry('s6') // pi 进程退出/删除汇聚点 → 缓存清除

    const after = await svc.getHistory('s6') // 无缓存 → 全量
    expect(calls[1]?.since).toBeUndefined()
    expect(after.messages.map((m) => m.piEntryId)).toEqual(['e2'])
  })

  it('离线路径（无 RPC client）：走尾读，不读不写缓存', async () => {
    // pm.getClient 返回 undefined 的独立环境
    const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
    const pm = { onSessionExit: vi.fn(), getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const svc = new SessionService(
      pm, broker,
      () => ({ attach: vi.fn(), detach: vi.fn() }) as never,
      '/test', {} as never, {} as never,
      { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never,
      { pruneStaleCache: vi.fn() } as never, {} as never,
    )
    const result = await svc.getHistory('s-offline')
    expect(getHistoryTailFromFile).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ messages: [], truncated: true })
  })
})
