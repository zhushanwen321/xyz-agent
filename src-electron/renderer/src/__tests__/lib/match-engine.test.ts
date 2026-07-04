/**
 * 匹配引擎（#1）纯函数单测。
 *
 * 覆盖 AC：
 * - AC-1.1 grep 验收（导出存在性）
 * - AC-1.2 纯函数（不修改原数组，无副作用）
 * - AC-1.3 边界条件（空查询 / 空 text / 空 items）
 * - AC-1.4 行为等价 BC-4（高亮切分 + 过滤正确性）
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/lib/match-engine.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  matchFilter,
  segments,
  type MatchSegment,
} from '@/lib/match-engine'

describe('match-engine (#1) —— 导出契约', () => {
  it('AC-1.1 matchFilter 与 segments 均为导出函数', () => {
    expect(typeof matchFilter).toBe('function')
    expect(typeof segments).toBe('function')
  })
})

describe('segments —— 高亮切分', () => {
  it('AC-1.3 空查询 → 单元素 hit:false（保留原 text）', () => {
    expect(segments('hello world', '')).toEqual([
      { text: 'hello world', hit: false },
    ])
  })

  it('AC-1.3 text 为空 → 单元素 {text:"", hit:false}', () => {
    expect(segments('', 'abc')).toEqual([{ text: '', hit: false }])
  })

  it('AC-1.3 text 与查询均为空 → [{text:"", hit:false}]', () => {
    expect(segments('', '')).toEqual([{ text: '', hit: false }])
  })

  it('AC-1.4 单次命中：前后未命中段 + 命中段（保留原大小写）', () => {
    const out = segments('auth/session.ts', 'session')
    expect(out).toEqual<MatchSegment[]>([
      { text: 'auth/', hit: false },
      { text: 'session', hit: true },
      { text: '.ts', hit: false },
    ])
  })

  it('AC-1.4 大小写不敏感：命中段保留原 text 大小写', () => {
    const out = segments('Hello World', 'world')
    expect(out).toEqual<MatchSegment[]>([
      { text: 'Hello ', hit: false },
      { text: 'World', hit: true },
    ])
  })

  it('AC-1.4 多次命中：每个命中点独立 hit:true 段', () => {
    const out = segments('abcabc', 'b')
    expect(out).toEqual<MatchSegment[]>([
      { text: 'a', hit: false },
      { text: 'b', hit: true },
      { text: 'ca', hit: false },
      { text: 'b', hit: true },
      { text: 'c', hit: false },
    ])
    // 显式断言：恰好两个命中段
    expect(out.filter((s) => s.hit)).toHaveLength(2)
  })

  it('AC-1.4 无命中 → 整段单元素 hit:false', () => {
    expect(segments('no match here', 'xyz')).toEqual([
      { text: 'no match here', hit: false },
    ])
  })
})

describe('matchFilter —— 子串过滤', () => {
  const items = [
    { title: 'auth/session.ts', sub: 'user authentication' },
    { title: 'settings.ts', sub: 'session timeout config' },
    { title: 'README.md', sub: 'project intro' },
  ]

  it('AC-1.3 空查询 → 返回全部（不过滤）', () => {
    expect(matchFilter(items, '')).toEqual(items)
  })

  it('AC-1.3 空 items → 空数组', () => {
    expect(matchFilter([], 'abc')).toEqual([])
  })

  it('AC-1.4 title 命中：保留命中项', () => {
    expect(matchFilter(items, 'settings')).toEqual([
      { title: 'settings.ts', sub: 'session timeout config' },
    ])
  })

  it('AC-1.4 sub 命中：保留命中项', () => {
    expect(matchFilter(items, 'timeout')).toEqual([
      { title: 'settings.ts', sub: 'session timeout config' },
    ])
  })

  it('AC-1.4 title 或 sub 任一命中均保留（"session" 命中两项）', () => {
    const out = matchFilter(items, 'session')
    expect(out).toHaveLength(2)
    expect(out.map((it) => it.title).sort()).toEqual([
      'auth/session.ts',
      'settings.ts',
    ])
  })

  it('AC-1.4 两者都不命中：返回空数组', () => {
    expect(matchFilter(items, 'zzz')).toEqual([])
  })

  it('AC-1.2 纯函数：不修改原数组引用与元素（无副作用）', () => {
    const before = items.slice()
    matchFilter(items, 'session')
    expect(items).toEqual(before)
    // 输入数组引用未变（仅 filter 产生新数组）
    expect(matchFilter(items, '')).toBe(items)
  })
})
