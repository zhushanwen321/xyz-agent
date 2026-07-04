/**
 * file-match 匹配度分级排序 单测。
 *
 * 覆盖：
 * - M1 basename 完全相等 > 前缀 > basename 子串 > path 子串（匹配度分级）
 * - M2 文件优先于目录（同匹配级内）
 * - M3 路径深度浅优先（同匹配级 + 同 type 内）
 * - M4 basename 字母序升序（兜底稳定排序）
 * - M5 无 query：全量返回，走次级排序（文件优先 + 浅优先 + 字母序）
 * - M6 不匹配的候选被过滤
 * - M7 大小写不敏感
 * - M8 回归：#agents 时 AGENTS.md（basename 前缀）排在 subagents 目录（basename 子串）前
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/lib/file-match.test.ts
 */
import { describe, it, expect } from 'vitest'
import { filterAndSortFileCandidates } from '@/lib/file-match'
import type { FileCandidate } from '@/lib/file-candidates'

/** 构造候选的辅助函数（减少样板） */
function mk(
  path: string,
  type: 'file' | 'dir',
  basename?: string,
): FileCandidate {
  const base = basename ?? path.split('/').pop() ?? path
  return {
    id: path,
    name: type === 'dir' ? `${path}/` : base,
    kind: type === 'dir' ? '目录' : '文件',
    path,
    type,
    basename: base,
  }
}

/** 取排序后的 basename 列表（便于断言顺序） */
function names(sorted: FileCandidate[]): string[] {
  return sorted.map((c) => c.basename ?? c.name)
}

describe('filterAndSortFileCandidates', () => {
  // ── M1 匹配度分级 ──
  it('M1 匹配度分级：完全相等 > 前缀 > basename 子串 > path 子串', () => {
    const candidates = [
      mk('docs/auth-guide.md', 'file'), // path 子串（basename=auth-guide 含 auth，实际是 basename 子串）
      mk('src/utils/auth-helpers.ts', 'file'), // path 子串（basename=auth-helpers 含 auth，basename 子串）
      mk('auth.ts', 'file'), // basename 前缀（auth.ts 以 auth 开头）
      mk('auth', 'file'), // basename 完全相等（auth === auth）
    ]
    const sorted = filterAndSortFileCandidates(candidates, 'auth')
    // auth（完全相等）> auth.ts（前缀）> 其余 basename 子串按字母序/深度
    expect(names(sorted)[0]).toBe('auth')
    expect(names(sorted)[1]).toBe('auth.ts')
  })

  // ── M2 文件优先于目录 ──
  it('M2 同匹配级内文件优先于目录', () => {
    const candidates = [
      mk('src/auth-helpers', 'dir'), // 目录，basename=auth-helpers，前缀匹配 auth
      mk('auth-helpers.ts', 'file'), // 文件，basename=auth-helpers.ts，前缀匹配 auth
    ]
    const sorted = filterAndSortFileCandidates(candidates, 'auth')
    // 两者都是 basename 前缀匹配（同级 level 1），文件优先于目录
    expect(names(sorted)[0]).toBe('auth-helpers.ts')
    expect(names(sorted)[1]).toBe('auth-helpers')
  })

  // ── M3 路径深度浅优先 ──
  it('M3 同匹配级 + 同 type 内，路径浅优先', () => {
    const candidates = [
      mk('a/b/c/deep.ts', 'file'), // depth 3，basename 子串
      mk('shallow.ts', 'file'), // depth 1，basename 子串（含 a? 不含）
    ]
    // query=ts：两者 basename 都含 ts（子串匹配同级，都是 file）
    const sorted = filterAndSortFileCandidates(candidates, 'ts')
    // shallow.ts（depth 1）优先于 a/b/c/deep.ts（depth 3）
    expect(names(sorted)[0]).toBe('shallow.ts')
  })

  // ── M4 字母序兜底 ──
  it('M4 同匹配级 + 同 type + 同深度，basename 字母序升序', () => {
    const candidates = [
      mk('zebra.ts', 'file'),
      mk('apple.ts', 'file'),
      mk('mango.ts', 'file'),
    ]
    const sorted = filterAndSortFileCandidates(candidates, 'ts')
    expect(names(sorted)).toEqual(['apple.ts', 'mango.ts', 'zebra.ts'])
  })

  // ── M5 无 query ──
  it('M5 无 query：全量返回，文件优先 + 浅优先 + 字母序', () => {
    const candidates = [
      mk('src/auth', 'dir'),
      mk('zebra.ts', 'file'),
      mk('apple.ts', 'file'),
    ]
    const sorted = filterAndSortFileCandidates(candidates, '')
    // 无 query 全返回；文件优先（apple.ts, zebra.ts 在前），目录在后
    expect(names(sorted)).toEqual(['apple.ts', 'zebra.ts', 'auth'])
  })

  // ── M6 不匹配过滤 ──
  it('M6 不匹配的候选被过滤掉', () => {
    const candidates = [
      mk('auth.ts', 'file'),
      mk('completely-unrelated.ts', 'file'),
    ]
    const sorted = filterAndSortFileCandidates(candidates, 'auth')
    expect(sorted).toHaveLength(1)
    expect(names(sorted)[0]).toBe('auth.ts')
  })

  // ── M7 大小写不敏感 ──
  it('M7 大小写不敏感（AGENTS 匹配 agents）', () => {
    const candidates = [mk('AGENTS.md', 'file')]
    const sorted = filterAndSortFileCandidates(candidates, 'agents')
    expect(sorted).toHaveLength(1)
    expect(names(sorted)[0]).toBe('AGENTS.md')
  })

  // ── M8 回归：#agents 时 AGENTS.md 排在 subagents 目录前 ──
  it('M8 回归：#agents 时 AGENTS.md（basename 前缀）排在 subagents 目录（basename 子串）前', () => {
    const candidates = [
      mk('extensions/subagents', 'dir'), // basename=subagents，含 agents 子串（basename 子串匹配）
      mk('.agents', 'dir'), // basename=.agents，含 agents 子串
      mk('AGENTS.md', 'file'), // basename=AGENTS.md，以 agents 开头（前缀匹配，大小写不敏感）
    ]
    const sorted = filterAndSortFileCandidates(candidates, 'agents')
    // AGENTS.md：basename 前缀匹配（level 1）+ 文件 → 最优先
    // subagents/.agents：basename 子串匹配（level 2）+ 目录 → 靠后
    expect(names(sorted)[0]).toBe('AGENTS.md')
    // 目录按字母序：.agents < subagents
    expect(names(sorted).slice(1)).toEqual(['.agents', 'subagents'])
  })
})
