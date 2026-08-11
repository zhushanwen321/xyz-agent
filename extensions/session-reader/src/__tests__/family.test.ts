import { describe, it, expect } from 'vitest'
import { buildFamilyIndex, resolveFamily } from '../core/family.js'
import type { Entry } from '../core/parser.js'

// ---- fixture 常量（映射 design §3.3 D-7 Q1 真实场景）----
const ROOT = '019fe620' // 家族根（无 parentSession）
const FORK = '019fe632' // fork 子代（parentSession 指向 ROOT 的文件）
const SUB = '019fe635' // subagent（rootSessionId=FORK，挂在 fork 子代下，非家族根）

// ---- fixture helpers ----

/** 构造 session header entry（type=session，含 id/cwd，可选 parentSession） */
function header(id: string, opts?: { parentSession?: string; cwd?: string }): Entry {
  const e: Entry = { type: 'session', id, parentId: null, cwd: opts?.cwd ?? '/proj' }
  if (opts?.parentSession) e.parentSession = opts.parentSession
  return e
}

/** 模拟真实文件路径：含 sessionId 的 jsonl 路径（resolveParentSessionId 靠 includes 反查） */
function sessionFile(id: string): string {
  return `/sessions/2026-08-09T10-45-20Z_${id}.jsonl`
}

/** 构造 subagent-identity custom entry（data.rootSessionId/slug） */
function subagentIdentity(id: string, rootSessionId: string, slug: string): Entry {
  return {
    type: 'custom',
    id,
    parentId: null,
    customType: 'subagent-identity',
    data: { rootSessionId, slug },
  }
}

/** 构造 fileStats Map（M1 key=sessionId） */
function makeStats(
  keys: string[],
  opts: { mtime?: number; size?: number } = {},
): Map<string, { mtime: number; size: number }> {
  const { mtime = 1000, size = 5000 } = opts
  const m = new Map<string, { mtime: number; size: number }>()
  for (const k of keys) m.set(k, { mtime, size })
  return m
}

/** Q1 核心 fixture：ROOT ← fork ← FORK；subagent SUB 挂在 fork 子代 FORK 下 */
function q1Fixture(aliveKeys: string[] = [ROOT, FORK, SUB]) {
  return {
    headers: [header(ROOT), header(FORK, { parentSession: sessionFile(ROOT) })],
    identities: [subagentIdentity(SUB, FORK, 'deep-survey')],
    fileStats: makeStats(aliveKeys),
  }
}

describe('buildFamilyIndex', () => {
  it('byId / childrenOf / subagentsByRoot 结构正确', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    expect(index.byId.has(ROOT)).toBe(true)
    expect(index.byId.has(FORK)).toBe(true)
    expect(index.byId.get(ROOT)?.cwd).toBe('/proj')

    // childrenOf key 是父 sessionId（经 parentSession 文件路径反查）
    expect(index.childrenOf.get(ROOT)).toHaveLength(1)
    expect(index.childrenOf.get(ROOT)?.[0].sessionId).toBe(FORK)

    // subagentsByRoot key 是 rootSessionId
    expect(index.subagentsByRoot.get(FORK)).toHaveLength(1)
    expect(index.subagentsByRoot.get(FORK)?.[0].sessionId).toBe(SUB)
    expect(index.subagentsByRoot.get(FORK)?.[0].slug).toBe('deep-survey')
  })

  it('parentSession 是文件路径：经 sessionId 子串反查建 childrenOf', () => {
    const headers = [
      header('aaa'),
      header('bbb', { parentSession: '/some/dir/2026-01-01T00-00-00Z_aaa.jsonl' }),
    ]
    const index = buildFamilyIndex(headers, [], new Map())

    expect(index.childrenOf.get('aaa')?.[0].sessionId).toBe('bbb')
  })

  it('parentSession 直接是 sessionId 也兼容（简化 fixture）', () => {
    const headers = [header('aaa'), header('bbb', { parentSession: 'aaa' })]
    const index = buildFamilyIndex(headers, [], new Map())

    expect(index.childrenOf.get('aaa')?.[0].sessionId).toBe('bbb')
  })

  it('parentSession 反查不到父 → 该 entry 不进 childrenOf（不报错）', () => {
    const headers = [header('bbb', { parentSession: '/missing.jsonl' })]
    const index = buildFamilyIndex(headers, [], new Map())

    expect(index.childrenOf.size).toBe(0)
  })

  it('identity 缺 rootSessionId/slug → 跳过（坏数据容错）', () => {
    const bad: Entry = {
      type: 'custom',
      id: 'x',
      parentId: null,
      customType: 'subagent-identity',
      data: { slug: 'no-root' },
    }
    const index = buildFamilyIndex([], [bad], new Map())

    expect(index.subagentsByRoot.size).toBe(0)
  })

  it('fileStats 原样存入 index（供 cleanedUp 判断用）', () => {
    const fileStats = makeStats(['s1'])
    const index = buildFamilyIndex([], [], fileStats)

    expect(index.fileStats).toBe(fileStats)
  })
})

describe('resolveFamily - 隔代关联（design §3.3 D-7 Q1 核心断言）', () => {
  it('从家族根 resolve 能关联到挂在 fork 子代下的隔代 subagent', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    const family = resolveFamily(ROOT, index)

    // Q1 核心：subagent SUB 的 rootSessionId 是 fork 子代 FORK，不是 root ROOT。
    // 只查 root 的 subagentsByRoot 会漏；必须对 fork 链每个节点（含 forks）查。
    expect(family.subagents.some((s) => s.sessionId === SUB)).toBe(true)
    expect(family.subagents.find((s) => s.sessionId === SUB)?.slug).toBe('deep-survey')
  })

  it('从 fork 子代 resolve 也能关联到直接挂在其下的 subagent', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    const family = resolveFamily(FORK, index)
    expect(family.subagents.some((s) => s.sessionId === SUB)).toBe(true)
  })
})

describe('resolveFamily - fork 链', () => {
  it('fork 子代的 parents 含 root；root 的 forks 含 fork 子代', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    expect(resolveFamily(FORK, index).parents.some((p) => p.sessionId === ROOT)).toBe(true)
    expect(resolveFamily(ROOT, index).forks.some((f) => f.sessionId === FORK)).toBe(true)
  })

  it('root 无 parentSession → parents 空、forks 取 childrenOf', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    const family = resolveFamily(ROOT, index)
    expect(family.parents).toEqual([])
    expect(family.forks.map((f) => f.sessionId)).toEqual([FORK])
  })

  it('线性多级 fork 链：C←B←A，resolveFamily(C).parents=[B,A]', () => {
    const headers = [
      header('A'),
      header('B', { parentSession: sessionFile('A') }),
      header('C', { parentSession: sessionFile('B') }),
    ]
    const index = buildFamilyIndex(headers, [], new Map())

    const family = resolveFamily('C', index)
    expect(family.parents.map((p) => p.sessionId)).toEqual(['B', 'A'])
    // forks 只含直接子代（孙代 C 是 B 的子代，不是 A 的直接子代）
    expect(resolveFamily('A', index).forks.map((f) => f.sessionId)).toEqual(['B'])
    expect(resolveFamily('B', index).forks.map((f) => f.sessionId)).toEqual(['C'])
  })

  it('workflows 恒为空数组（M1，接口字段保留供 M2）', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    expect(resolveFamily(ROOT, index).workflows).toEqual([])
  })
})

describe('resolveFamily - cleanedUp（subagent 文件被 GC）', () => {
  it('identity 在但 fileStats 不含其 sessionId → cleanedUp=true', () => {
    const { headers, identities, fileStats } = q1Fixture([ROOT, FORK]) // SUB 不在 fileStats（已 GC）
    const index = buildFamilyIndex(headers, identities, fileStats)

    const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
    expect(sub?.cleanedUp).toBe(true)
  })

  it('identity 在且 fileStats 含其 sessionId → cleanedUp=false', () => {
    const { headers, identities, fileStats } = q1Fixture() // 默认 [ROOT,FORK,SUB]，SUB 存活
    const index = buildFamilyIndex(headers, identities, fileStats)

    const sub = resolveFamily(ROOT, index).subagents.find((s) => s.sessionId === SUB)
    expect(sub?.cleanedUp).toBe(false)
  })
})

describe('resolveFamily - 错误', () => {
  it('sessionId 不在 index → 抛 Error', () => {
    const { headers, identities, fileStats } = q1Fixture()
    const index = buildFamilyIndex(headers, identities, fileStats)

    expect(() => resolveFamily('unknown-session', index)).toThrow(/not found in family index/)
  })
})
