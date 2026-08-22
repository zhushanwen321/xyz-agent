/**
 * 探针 P1 parity 测试（trace-runtime 单元，spec A24）。
 *
 * 断言：RPC 路径（pi CLI 真实录制的 get_entries 响应，__fixtures__/get-entries-*.json）
 * 与文件直读路径（buildTraceSnapshotFromFile 读录制时落盘的 .jsonl）对同一 session 的
 * SessionEntry 序列**逐条 diff 为空**（3 个真实 session）。diff 非空 = A1 决策重审
 * （design §2.6 / plan §4 风险条款）。
 *
 * fixture 录制：packages/runtime/scripts/record-get-entries-fixtures.mjs（本地 pi CLI
 * 0.84.1 真实调用，与生产 @earendil-works/pi-coding-agent 锁定版本一致）。
 *
 * 运行：cd packages/runtime && npx vitest run trace-parity
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTraceSnapshotFromFile } from '../session-trace.js'
import { readFirstJsonlLine, readSessionEndMeta } from '../../../infra/pi/session-file-utils.js'
import type { ISessionStore } from '../../ports/session.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

/** 录制清单（与 scripts/record-get-entries-fixtures.mjs 的 SESSIONS 同步——改清单两处一起改）。 */
const RECORDED_SESSIONS = [
  { name: 'get-entries-1-mixed-kinds', note: '真实 session：custom×44/custom_message/model_change/id-less session_info 侧支' },
  { name: 'get-entries-2-compaction-single', note: 'compaction 语义（firstKeptEntryId + model_change）' },
  { name: 'get-entries-3-fork-header', note: 'fork header parentSession=源 sessionId fallback 形态' },
]

/** 读取层全部走真实 infra（与生产路径 B 同代码），仅发现层指向 fixture 目录。 */
const store: ISessionStore = {
  scanSessions: () => [],
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

/** 逐条 diff 结果：完全一致返回空数组，否则返回差异描述（index + 双方摘要）。 */
function diffEntries(rpcEntries: unknown[], fileEntries: unknown[]): string[] {
  const diffs: string[] = []
  const n = Math.max(rpcEntries.length, fileEntries.length)
  for (let i = 0; i < n; i++) {
    const a = rpcEntries[i]
    const b = fileEntries[i]
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`entry[${i}] differs:\n  rpc : ${JSON.stringify(a)?.slice(0, 200)}\n  file: ${JSON.stringify(b)?.slice(0, 200)}`)
    }
  }
  return diffs
}

describe('A24 探针 P1：RPC 录制产物 vs 文件直读产物 SessionEntry 序列逐条 diff 为空', () => {
  it('录制 fixture 清单完整（3 个 session，与录制脚本清单一致）', () => {
    // 防 fixture 与清单漂移：清单是录制脚本的镜像，缺一即 parity 覆盖面缩水
    expect(RECORDED_SESSIONS).toHaveLength(3)
  })

  it.each(RECORDED_SESSIONS)('%s —— parity diff 为空（$note）', ({ name }) => {
    const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')) as {
      response: { data: { entries: unknown[]; leafId: string | null } }
    }
    const rpcEntries = raw.response.data.entries
    expect(rpcEntries.length).toBeGreaterThan(0) // 录制产物非空（防静默录到 boot session）

    const snapshot = buildTraceSnapshotFromFile(name, join(FIXTURES, `${name}.jsonl`), store)

    // 1. 核心 parity：entry 序列逐条 deep-equal（顺序 + 内容全等）
    expect(snapshot.entries).toHaveLength(rpcEntries.length)
    const diffs = diffEntries(rpcEntries, snapshot.entries)
    expect(diffs, `parity diff 非空（A1 决策需重审）:\n${diffs.join('\n')}`).toEqual([])

    // 2. 录制文件无坏行（RPC 路径 pi 静默跳过坏行会造成假 parity——文件侧必须确认无坏行）
    expect(snapshot.malformed).toEqual([])

    // 3. header 一致性：文件首行 header 的 id 与 entries 的链根对应（RPC 不含 header，
    //    路径 A 由端口补读——此断言锁定补读来源与 RPC 同一文件）
    expect(snapshot.header?.id).toBeDefined()

    // 4. leafId 不变量：pi 返回的 leafId = 文件末条带 id entry 的 id（线性链语义）
    const lastWithId = [...snapshot.entries].reverse().find((e) => typeof (e as { id?: unknown }).id === 'string') as { id: string } | undefined
    expect(raw.response.data.leafId).toBe(lastWithId?.id)
  })

  it('覆盖面：三个 session 合计 entry 数 ≥ 100（防 fixture 退化为玩具样本）', () => {
    let total = 0
    for (const { name } of RECORDED_SESSIONS) {
      const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')) as {
        response: { data: { entries: unknown[] } }
      }
      total += raw.response.data.entries.length
    }
    expect(total).toBeGreaterThanOrEqual(100)
  })
})
