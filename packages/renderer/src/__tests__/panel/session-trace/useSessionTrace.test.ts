/**
 * A41 per-session trace store 单测（trace-ui，ADR-0049 useSessionScopedState 分区）。
 *
 * 覆盖：加载/增量/过滤/选中 per-session 分区隔离，切 session 不串；
 * 增量腿 entry.id 去重追加 + empty（未落盘）→ 增量触发全量重拉；
 * loading 窗口推送缓冲 flush（竞态：推送先于回包到达不丢行）；
 * cleanup 退订 events handler（防 per 删除 session 监听泄漏）；
 * payload → rows 派生（mergeTraceLines 归并 + core mapSessionTraceRows）。
 *
 * 真实 events 模块（内存路由，dispatchSession 触发订阅 handler——非 mock 订阅链路）；
 * '@/api' 门面 mock（session.getTraceEntries 受控）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-trace/useSessionTrace.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import * as events from '@/api/events'
import { triggerSessionCleanups } from '@xyz-agent/core/foundation/use-session-scoped-state'
import { mapSessionTraceRows, resolveTraceRowKind } from '@xyz-agent/core/domain/session-trace'
import type { ServerMessageMap } from '@xyz-agent/shared'

// ── mock '@/api' 门面（store 只消费 session.getTraceEntries）──
const apiMock = vi.hoisted(() => ({ getTraceEntries: vi.fn() }))
vi.mock('@/api', () => ({
  session: { getTraceEntries: apiMock.getTraceEntries },
}))

// 动态 import 让 vi.mock 先生效
import * as traceStore from '@/composables/features/trace/useSessionTrace'
import { mergeTraceLines } from '@/composables/features/trace/trace-lines'

/** 切换 panel 绑定的 session（分区键跟随，模拟 sidebar selectSession 主路径） */
function focusSession(sid: string | null): void {
  usePanelStore().loadSession(ROOT_PANEL_ID, sid)
}

/** 当前分区的只读快照（A 分区断言用；partition 是跟分区键的 computed） */
function partitionOf(sid: string): traceStore.TraceSessionPartition {
  focusSession(sid)
  return JSON.parse(JSON.stringify(traceStore.useSessionTrace().partition.value)) as traceStore.TraceSessionPartition
}

function snapshotOf(sid: string, entries: unknown[], extra: Partial<ServerMessageMap['session.traceEntries']> = {}): ServerMessageMap['session.traceEntries'] {
  return { sessionId: sid, source: 'file', entries, malformed: [], ...extra }
}

function pushAppend(sid: string, entries: unknown[], leafId: string | null): void {
  events.dispatchSession(sid, {
    type: 'session.traceEntryAppended',
    id: `push-${Math.random().toString(36).slice(2, 8)}`,
    payload: { sessionId: sid, entries, leafId },
  })
}

const SID_A = 'sid-a-1111'
const SID_B = 'sid-b-2222'

describe('A41 per-session trace store（ADR-0049 useSessionScopedState 分区）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.getTraceEntries.mockReset()
    traceStore._resetTraceStoreForTest()
    setActivePinia(createPinia())
    // 重绑分区键（_resetForTest 解绑后模拟产品接线）
    traceStore.bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
    focusSession(null)
  })

  it('加载按 session 分区：各 session 各自数据，切走再切回不重拉不丢失', async () => {
    const entriesA = [{ type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'A 的消息' } }]
    const entriesB = [{ type: 'message', id: 'f1', parentId: null, message: { role: 'user', content: 'B 的消息' } }]
    apiMock.getTraceEntries.mockImplementation(async (sid: string) =>
      sid === SID_A ? snapshotOf(SID_A, entriesA) : snapshotOf(SID_B, entriesB))

    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'))
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(1)

    // 切到 B：独立分区加载，A 数据不被覆盖/清空
    focusSession(SID_B)
    traceStore.ensureTraceLoaded(SID_B)
    await vi.waitFor(() => expect(partitionOf(SID_B).status).toBe('ready'))
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(2)

    // 切回 A：数据保留 + 不重拉（幂等：ready 态 ensureTraceLoaded no-op）
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await Promise.resolve()
    expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(2)
    expect(partitionOf(SID_A).entries).toHaveLength(1)
    expect((partitionOf(SID_A).entries[0] as { id?: string }).id).toBe('e1')
  })

  it('增量腿：traceEntryAppended 按消息所属 session 写分区（去重追加 + leafId 滚动），不串其他 session', async () => {
    const u1 = { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'q1' } }
    apiMock.getTraceEntries.mockResolvedValue(snapshotOf(SID_A, [u1]))
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'))

    // 增量：新 entry 追加 + leafId 更新
    const a1 = { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [] } }
    pushAppend(SID_A, [a1], 'e2')
    expect(partitionOf(SID_A).entries).toHaveLength(2)
    expect(partitionOf(SID_A).leafId).toBe('e2')

    // 重复推送同一 id：去重（protocol「消费端按 entry.id 去重追加」）
    pushAppend(SID_A, [a1], 'e2')
    expect(partitionOf(SID_A).entries).toHaveLength(2)

    // B 的增量推给 B：A 不受影响；B 未加载过（idle）不增量
    const b1 = { type: 'message', id: 'x9', parentId: null, message: { role: 'user', content: 'B 增量' } }
    pushAppend(SID_B, [b1], 'x9')
    expect(partitionOf(SID_A).entries).toHaveLength(2)
    expect(partitionOf(SID_B).status).toBe('idle')
    expect(partitionOf(SID_B).entries).toHaveLength(0)
  })

  it('过滤/选中/视图状态 per-session 隔离：A 设置后切 B 是默认值，切回 A 保留', async () => {
    apiMock.getTraceEntries.mockResolvedValue(snapshotOf(SID_A, []))
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'))

    // A：切 Trace 视图 + 设过滤 + 选中
    traceStore.setTraceView(SID_A, 'trace')
    traceStore.setTraceFilter(SID_A, { contextOnly: true, activeGroups: ['messages'], searchText: 'retry' })
    traceStore.selectTraceEntry(SID_A, 'e1')
    const partA = partitionOf(SID_A)
    expect(partA.view).toBe('trace')
    expect(partA.contextOnly).toBe(true)
    expect(partA.activeGroups).toEqual(['messages'])
    expect(partA.searchText).toBe('retry')
    expect(partA.selectedKey).toBe('e1')

    // 切 B：默认值（不串）
    const partB = partitionOf(SID_B)
    expect(partB.view).toBe('chat')
    expect(partB.contextOnly).toBe(false)
    expect(partB.activeGroups).toEqual([])
    expect(partB.searchText).toBe('')
    expect(partB.selectedKey).toBeNull()

    // 切回 A：保留
    expect(partitionOf(SID_A).selectedKey).toBe('e1')
    traceStore.clearTraceSelection(SID_A)
    expect(partitionOf(SID_A).selectedKey).toBeNull()
  })

  it('empty（未落盘）→ 收到增量自动全量重拉（「落盘后自动加载」）', async () => {
    let call = 0
    apiMock.getTraceEntries.mockImplementation(async () => {
      call++
      // 首次 empty（延迟写入窗口），重拉返回真实数据
      return call === 1
        ? snapshotOf(SID_A, [], { source: 'empty' })
        : snapshotOf(SID_A, [{ type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'q' } }])
    })
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).source).toBe('empty'))

    pushAppend(SID_A, [], 'e1') // 触发事件到达（delta 可能已并入下次全量）
    await vi.waitFor(() => expect(apiMock.getTraceEntries).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(partitionOf(SID_A).entries).toHaveLength(1))
    expect(partitionOf(SID_A).source).toBe('file')
  })

  it('加载失败进 error 态（code 保留供失败路径文案），重试可恢复', async () => {
    let call = 0
    apiMock.getTraceEntries.mockImplementation(async () => {
      call++
      if (call === 1) throw Object.assign(new Error('boom'), { code: 'trace_fetch_failed' })
      return snapshotOf(SID_A, [])
    })
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('error'))
    expect(partitionOf(SID_A).errorCode).toBe('trace_fetch_failed')

    traceStore.retryTraceLoad(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'))
  })

  it('loading 窗口内的推送不丢：回包后 flush（快照已有 id 去重 + 快照后新 entry 追加 + leafId 滚动）', async () => {
    // 复现 review 竞态：runtime 写增量基线后，traceEntryAppended 推送先于 RPC reply 到达
    // renderer——手动 resolve 制造 loading 窗口，推送既不在快照里也不会被 sync 补发
    let resolveSnap!: (v: ServerMessageMap['session.traceEntries']) => void
    apiMock.getTraceEntries.mockImplementation(
      () => new Promise<ServerMessageMap['session.traceEntries']>((res) => { resolveSnap = res }),
    )
    const u1 = { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'q1' } }
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('loading'))

    // 窗口内推送：e1 快照里已有（flush 时去重）+ e2 是快照后新 entry（不得丢，否则台账永久缺行）
    const a1 = { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [] } }
    pushAppend(SID_A, [u1, a1], 'e2')

    resolveSnap(snapshotOf(SID_A, [u1]))
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'))
    expect(partitionOf(SID_A).entries.map((e) => (e as { id?: string }).id)).toEqual(['e1', 'e2'])
    expect(partitionOf(SID_A).leafId).toBe('e2')
  })

  it('cleanup 退订增量 handler：triggerSessionCleanups 后 events.off 移除该 sid 的订阅 handler', async () => {
    apiMock.getTraceEntries.mockResolvedValue(snapshotOf(SID_A, []))
    const onSpy = vi.spyOn(events, 'on')
    focusSession(SID_A)
    traceStore.ensureTraceLoaded(SID_A)
    await vi.waitFor(() => expect(partitionOf(SID_A).status).toBe('ready'))
    // 前置：loadTrace → ensureIncrementSubscription 确实建立了订阅
    const handler = onSpy.mock.calls.find(([sid]) => sid === SID_A)?.[1]
    expect(handler).toBeTypeOf('function')
    onSpy.mockRestore()

    const offSpy = vi.spyOn(events, 'off')
    triggerSessionCleanups(SID_A) // useSidebar.deleteSession 的 session 销毁编排路径
    // 不退订则 handler 永久滞留 events 内部 Map（per 删除 session 泄漏）+ 迟到推送可复活已删分区
    expect(offSpy).toHaveBeenCalledWith(SID_A, handler)
    offSpy.mockRestore()
  })

  it('payload → rows 派生：mergeTraceLines 坏行归并 + core 映射（损坏行占位原位可见）', () => {
    const header = { type: 'session', version: 1, id: 'h0', cwd: '/w' }
    const entries = [
      { type: 'message', id: 'e1', parentId: 'h0', message: { role: 'user', content: 'q1' } },
      { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [] } },
    ]
    const malformed = [{ lineNumber: 3, raw: 'not json' }]
    const lines = mergeTraceLines(header, entries, malformed)
    // 行1 header / 行2 e1 / 行3 坏行（原位归并）/ 行4 e2
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4])
    expect(lines[2]).toMatchObject({ ok: false, raw: 'not json' })

    const rows = mapSessionTraceRows({
      lines,
      sessionEnd: { type: 'session_end', outcome: 'done' },
      leafId: 'e2',
    })
    expect(rows.map((r) => r.kind)).toEqual(['SESSION', 'USER', 'MALFORMED', 'ASSISTANT', 'BOUNDARY'])
    expect(rows[2]).toMatchObject({ key: 'malformed:3', raw: 'not json' })
    // 12 kind 映射冒烟：resolveTraceRowKind 对关键 entry 的归类
    expect(resolveTraceRowKind({ type: 'message', message: { role: 'bashExecution', command: 'ls' } })).toBe('BASH')
    expect(resolveTraceRowKind({ type: 'model_change', provider: 'p', modelId: 'm' })).toBe('LIFECYCLE')
  })

  it('文件尾坏行：直读快照 → rows 尾部 MALFORMED 占位可见，后续增量追加不吞占位（GUI 回归 pin）', () => {
    // GUI 实测形态（dsh调研 session）：文件尾部注入坏行后，直读路径快照 malformed 带
    // 尾部行号；后续增量腿（如现取 DATA xyz:current-system-prompt）往 entries 尾部追加
    // 新 entry。两者交互下 MALFORMED 占位必须仍可见且位于追加行之前（坏行行号锚点归并）。
    const header = { type: 'session', version: 1, id: 'h0', cwd: '/w' }
    const fileEntries = [
      { type: 'message', id: 'e1', parentId: 'h0', message: { role: 'user', content: 'q' } },
      { type: 'session_info', name: 'repro' },
    ]
    const tailMalformed = [{ lineNumber: 4, raw: '{invalid json!!!' }]

    // 阶段 1：快照直出 → MALFORMED 是尾行
    const rows1 = mapSessionTraceRows({ lines: mergeTraceLines(header, fileEntries, tailMalformed) })
    expect(rows1.map((r) => r.kind)).toEqual(['SESSION', 'USER', 'LIFECYCLE', 'MALFORMED'])
    expect(rows1[3]).toMatchObject({ key: 'malformed:4', lineNumber: 4, raw: '{invalid json!!!' })

    // 阶段 2：增量追加后（现取 DATA 行 append 到 entries 尾部）→ MALFORMED 归并在追加行之前
    const appended = [...fileEntries, { type: 'custom', customType: 'xyz:current-system-prompt', data: {} }]
    const rows2 = mapSessionTraceRows({ lines: mergeTraceLines(header, appended, tailMalformed) })
    expect(rows2.map((r) => r.kind)).toEqual(['SESSION', 'USER', 'LIFECYCLE', 'MALFORMED', 'DATA'])
    expect(rows2[3]).toMatchObject({ key: 'malformed:4' })
    expect(rows2[4]).toMatchObject({ kind: 'DATA' })
  })
})
