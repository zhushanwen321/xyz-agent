/**
 * renderer lib/subagent-bucket.test.ts —— 分桶判据 SSOT 模块单测
 * （设计 subagent-sidebar-filter §3.4 / 实施计划 u-foundation / T1）。
 *
 * 三视角：
 * - 白盒：全部 SubagentStatus（shared SUBAGENT_STATUS_ALL，[B3] 不再本地硬拷贝）×
 *   {done 投影 / waiting / streaming} 形态矩阵的分桶断言
 *   （D4 核心回归：done 投影归「已结束」而非「进行中」）+ isDoneProjection SSOT 直测
 * - 黑盒：filterSubagents 三值行为（'all' 原数组引用直通 / active·ended 过滤正确）、
 *   countSubagents 计数一致性（active + ended === all）、空数组全 0
 * - 形态：导出符号齐全（DEFAULT_SUBAGENT_FILTER === 'active'）
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/lib/subagent-bucket.test.ts
 */
import { describe, it, expect } from 'vitest'
import { SUBAGENT_STATUS_ALL, type SubagentRecord, type SubagentStatus } from '@xyz-agent/shared'
import {
  DEFAULT_SUBAGENT_FILTER,
  isDoneProjection,
  subagentBucket,
  filterSubagents,
  countSubagents,
  type SubagentFilterValue,
  type SubagentBucket,
} from '@/lib/subagent-bucket'

/**
 * [B3] 全集数据源 = shared 导出的 SUBAGENT_STATUS_ALL（不再本地硬拷贝）：shared 扩
 * SubagentStatus 枚举时同步该元组，下方全部形态矩阵即自动覆盖新值；漏同步则由
 * shared 侧编译锁（_subagentStatusCoversAll）与全集覆盖矩阵断言分别拦截。
 */
const ALL_STATUSES: readonly SubagentStatus[] = SUBAGENT_STATUS_ALL

/** 构造最小合法 SubagentRecord（仅必填字段 + 形态字段注入） */
function makeRecord(status: SubagentStatus, extra: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: `bg-test-${status}-${Math.random().toString(36).slice(2, 8)}`,
    sessionFile: null,
    agent: 'reviewer',
    slug: 'review-1',
    task: 'review the diff',
    status,
    ...extra,
  }
}

describe('subagentBucket 形态矩阵（白盒：6 status × 三投影形态，设计 D4）', () => {
  it('done 投影形态（result 在场 + chatMode 显式 false）→ 全部 6 种 status 均落 ended', () => {
    for (const status of ALL_STATUSES) {
      const record = makeRecord(status, { result: 'round output', chatMode: false })
      expect(subagentBucket(record), `status=${status} 的 done 投影应落 ended`).toBe('ended')
    }
  })

  it('D4 核心回归：running + done 投影必须归 ended 而非 active（绿点轮终记录不得滞留「进行中」桶）', () => {
    // 轮终 running-resumable 是稳定态（doFinalizeRoundToIdle 故意回写 running），
    // 若此断言翻红即 v1 被击穿的「status === 'running' 一行谓词」回归。
    const record = makeRecord('running', { result: 'round output', chatMode: false })
    expect(subagentBucket(record)).toBe('ended')
    expect(subagentBucket(record)).not.toBe('active')
  })

  it('waiting 形态（running + chatMode:true）→ running 落 active；非 running 同形态仍落 ended', () => {
    for (const status of ALL_STATUSES) {
      const record = makeRecord(status, { chatMode: true })
      const expected: SubagentBucket = status === 'running' ? 'active' : 'ended'
      expect(subagentBucket(record), `status=${status} 的 waiting(chat) 应落 ${expected}`).toBe(expected)
    }
  })

  it('waiting 形态（running + resumable:true，孤儿兜底）→ running 落 active；非 running 同形态仍落 ended', () => {
    for (const status of ALL_STATUSES) {
      const record = makeRecord(status, { resumable: true })
      const expected: SubagentBucket = status === 'running' ? 'active' : 'ended'
      expect(subagentBucket(record), `status=${status} 的 waiting(孤儿) 应落 ${expected}`).toBe(expected)
    }
  })

  it('streaming 形态（running 无 result 无 resumable）→ running 落 active；非 running 同形态仍落 ended', () => {
    for (const status of ALL_STATUSES) {
      const record = makeRecord(status)
      const expected: SubagentBucket = status === 'running' ? 'active' : 'ended'
      expect(subagentBucket(record), `status=${status} 的 streaming 应落 ${expected}`).toBe(expected)
    }
  })
})

describe('isDoneProjection（白盒 SSOT 直测：仅 running + result 在场 + chatMode 显式 false）', () => {
  it('running + result + chatMode:false → true（done 投影本体）', () => {
    expect(isDoneProjection(makeRecord('running', { result: 'round output', chatMode: false }))).toBe(true)
  })

  it('running + result 空串 + chatMode:false → true（「result 在场」= !== undefined，非真值判定）', () => {
    expect(isDoneProjection(makeRecord('running', { result: '', chatMode: false }))).toBe(true)
  })

  it('chatMode 缺省（v1 前存量 entry undefined）→ false（保守：无法确认不是 chat 不宣告完成）', () => {
    expect(isDoneProjection(makeRecord('running', { result: 'round output' }))).toBe(false)
  })

  it('result 缺省 → false（首轮未完成，真在跑）', () => {
    expect(isDoneProjection(makeRecord('running', { chatMode: false }))).toBe(false)
  })

  it('chatMode:true → false（chat 轮终等续聊，waiting 非完成）', () => {
    expect(isDoneProjection(makeRecord('running', { result: 'round output', chatMode: true }))).toBe(false)
  })

  it('resumable:true 但 chatMode 缺省 → false（孤儿兜底不落 done 投影）', () => {
    expect(isDoneProjection(makeRecord('running', { result: 'round output', resumable: true }))).toBe(false)
  })

  it('非 running 终态（含显式 done）→ false（本函数只描述 running 形态投影，显式终态由 subagentBucket 首分支承接）', () => {
    for (const status of ALL_STATUSES.filter((s) => s !== 'running')) {
      expect(isDoneProjection(makeRecord(status, { result: 'x', chatMode: false })), `status=${status}`).toBe(false)
    }
  })
})

describe('filterSubagents（黑盒：三值行为）', () => {
  /** 混合 fixture：2 active（streaming + waiting-chat）+ 4 ended（done 投影 / done / failed / closed） */
  function makeMixedRecords(): SubagentRecord[] {
    return [
      makeRecord('running'), // streaming → active
      makeRecord('running', { chatMode: true }), // waiting → active
      makeRecord('running', { result: 'round output', chatMode: false }), // done 投影 → ended
      makeRecord('done'), // 显式终态 → ended
      makeRecord('failed'), // 显式终态 → ended
      makeRecord('closed'), // 显式终态 → ended
    ]
  }

  it("'all' 返回原数组引用（零拷贝直通，非过滤副本）", () => {
    const records = makeMixedRecords()
    expect(filterSubagents(records, 'all')).toBe(records)
  })

  it("'active' 只保留 active 桶记录（streaming + waiting，不含 done 投影）", () => {
    const records = makeMixedRecords()
    const active = filterSubagents(records, 'active')
    expect(active.map((r) => r.status)).toEqual(['running', 'running'])
    expect(active.every((r) => subagentBucket(r) === 'active')).toBe(true)
  })

  it("'ended' 只保留 ended 桶记录（done 投影 + 全部显式终态）", () => {
    const records = makeMixedRecords()
    const ended = filterSubagents(records, 'ended')
    expect(ended.map((r) => r.subagentId)).toEqual([records[2], records[3], records[4], records[5]].map((r) => r.subagentId))
    expect(ended.every((r) => subagentBucket(r) === 'ended')).toBe(true)
  })

  it('过滤返回新数组且不变更原数组（无副作用）', () => {
    const records = makeMixedRecords()
    const snapshot = [...records]
    const active = filterSubagents(records, 'active')
    expect(active).not.toBe(records)
    expect(records).toEqual(snapshot)
  })

  it("空数组 → 三值均返回空（'all' 直通原引用）", () => {
    const empty: SubagentRecord[] = []
    expect(filterSubagents(empty, 'all')).toBe(empty)
    expect(filterSubagents(empty, 'active')).toEqual([])
    expect(filterSubagents(empty, 'ended')).toEqual([])
  })
})

describe('countSubagents（黑盒：计数一致性）', () => {
  it('active + ended === all，且与 filterSubagents 各桶长度一致（G3 计数预告口径）', () => {
    const records = [
      makeRecord('running'), // active
      makeRecord('running', { chatMode: true }), // active
      makeRecord('running', { result: 'round output', chatMode: false }), // ended（done 投影）
      makeRecord('done'), // ended
      makeRecord('crashed'), // ended
    ]
    const counts = countSubagents(records)
    expect(counts.active + counts.ended).toBe(counts.all)
    expect(counts.all).toBe(records.length)
    expect(counts.active).toBe(filterSubagents(records, 'active').length)
    expect(counts.ended).toBe(filterSubagents(records, 'ended').length)
    expect(counts).toEqual({ active: 2, ended: 3, all: 5 })
  })

  it('空数组 → 三桶全 0', () => {
    expect(countSubagents([])).toEqual({ active: 0, ended: 0, all: 0 })
  })

  it('边界：全 active / 全 ended', () => {
    expect(countSubagents([makeRecord('running'), makeRecord('running', { resumable: true })])).toEqual({
      active: 2,
      ended: 0,
      all: 2,
    })
    expect(countSubagents([makeRecord('cancelled'), makeRecord('closed')])).toEqual({
      active: 0,
      ended: 2,
      all: 2,
    })
  })
})

describe('导出形态（观察者：SSOT 模块公共面齐全）', () => {
  it("DEFAULT_SUBAGENT_FILTER === 'active'（G1：打开 Agents tab 默认「进行中」）", () => {
    expect(DEFAULT_SUBAGENT_FILTER).toBe('active')
  })

  it('四个判据函数均已导出且为函数', () => {
    expect(typeof isDoneProjection).toBe('function')
    expect(typeof subagentBucket).toBe('function')
    expect(typeof filterSubagents).toBe('function')
    expect(typeof countSubagents).toBe('function')
  })

  it('类型面：SubagentFilterValue 三值空间 / SubagentBucket 二值空间（值域由 vue-tsc typecheck:test 编译期守卫）', () => {
    const filterValues: SubagentFilterValue[] = ['active', 'ended', 'all']
    const bucketValues: SubagentBucket[] = ['active', 'ended']
    expect(filterValues).toContain(DEFAULT_SUBAGENT_FILTER)
    expect(bucketValues).toContain(subagentBucket(makeRecord('running')))
  })
})

// ── [B3] 全集覆盖矩阵（adversarial-review-fixes §3.3 B3）──────────────────────
//
// 护栏语义：Record<SubagentStatus, SubagentBucket> 断言表是显式的「枚举 → 桶归属」
// 决策记录——shared 扩枚举后此表缺新键时，循环取值为 undefined 与实际桶值不等，
// 本矩阵翻红；翻红处置 = 评估新值桶归属（进行中类必须落 active，不得静默落
// subagentBucket 反向白名单的 ended），补键后再绿。矩阵与 ALL_STATUSES（shared
// SUBAGENT_STATUS_ALL）双源互证：矩阵多键（枚举已缩）或循环源缺值（元组漏扩）
// 均可被下方覆盖数断言抓出。

describe('[B3] 全集覆盖矩阵（SUBAGENT_STATUS_ALL 每值都有显式桶归属断言）', () => {
  /** 枚举 → 桶归属的显式断言表（决策记录：扩枚举须先评估再补键，缺键即红） */
  const BUCKET_MATRIX: Record<SubagentStatus, SubagentBucket> = {
    running: 'active', // 唯一非终态（waiting / done 投影细分见上方形态矩阵）
    done: 'ended',
    failed: 'ended',
    cancelled: 'ended',
    crashed: 'ended',
    closed: 'ended',
  }

  it('每个枚举值的 streaming 形态（无附加形态字段）桶归属与断言表一致', () => {
    for (const status of ALL_STATUSES) {
      expect(
        subagentBucket(makeRecord(status)),
        `status=${status} 的桶归属与 BUCKET_MATRIX 声明不符（扩枚举后未评估桶归属？）`,
      ).toBe(BUCKET_MATRIX[status])
    }
  })

  it('断言表键集 = SUBAGENT_STATUS_ALL 全集（矩阵缺键/多键即覆盖数失配）', () => {
    // 覆盖数双向：矩阵键数 === 全集长度（多键 = 枚举已缩未清矩阵；循环全集时缺键
    // 在上一用例以 undefined ≠ 实际桶值暴露）
    expect(Object.keys(BUCKET_MATRIX).length).toBe(SUBAGENT_STATUS_ALL.length)
    expect(Object.keys(BUCKET_MATRIX).sort()).toEqual([...SUBAGENT_STATUS_ALL].sort())
  })

  it('SUBAGENT_STATUS_ALL 无重复值且含 running（分桶判据的反向白名单基准值）', () => {
    expect(new Set(SUBAGENT_STATUS_ALL).size).toBe(SUBAGENT_STATUS_ALL.length)
    expect(SUBAGENT_STATUS_ALL).toContain('running')
  })
})
