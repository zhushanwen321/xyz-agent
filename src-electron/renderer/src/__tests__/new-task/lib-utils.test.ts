/**
 * lib/utils 纯函数单测 —— resolveDefaultCwd / recentWorkspaces（#4 数据基座）。
 *
 * 覆盖：
 * - resolveDefaultCwd：空列表→undefined；含历史→最近活跃 session 的 cwd；cwd 脏数据跳过（AC-4.2/4.5）
 * - recentWorkspaces：distinct cwd top10 按 lastActiveAt 倒序；空列表→[]；同 cwd 去重保留最新（AC-4.1/4.6）
 *
 * mock 策略：纯函数无外部依赖，直接 import 断言，无 mock。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/lib-utils.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { SessionSummary } from '@xyz-agent/shared'
import { resolveDefaultCwd, recentWorkspaces } from '@/lib/utils'

/** 构造 SessionSummary 测试桩（仅本期派生用到的字段有意义） */
function mk(partial: Partial<SessionSummary>): SessionSummary {
  return {
    id: partial.id ?? 's',
    label: partial.label ?? 'label',
    cwd: partial.cwd ?? '/repo',
    status: 'idle',
    lastActiveAt: partial.lastActiveAt ?? 0,
    modelId: 'm',
    tokenCount: 0,
    ...partial,
  }
}

describe('resolveDefaultCwd', () => {
  it('空列表 → undefined（首次启动，AC-4.2）', () => {
    expect(resolveDefaultCwd([])).toBeUndefined()
  })

  it('单 session → 该 session 的 cwd', () => {
    expect(resolveDefaultCwd([mk({ cwd: '/a', lastActiveAt: 1 })])).toBe('/a')
  })

  it('多 session → 取 lastActiveAt 最大者的 cwd（AC-4.1 G1.1）', () => {
    const sessions = [
      mk({ id: 'old', cwd: '/old', lastActiveAt: 100 }),
      mk({ id: 'recent', cwd: '/recent', lastActiveAt: 900 }),
      mk({ id: 'mid', cwd: '/mid', lastActiveAt: 500 }),
    ]
    expect(resolveDefaultCwd(sessions)).toBe('/recent')
  })

  it('cwd 为空串/undefined 的脏数据 → 跳过，不回退到脏 session（AC-4.5）', () => {
    const sessions = [
      mk({ id: 'dirty', cwd: '', lastActiveAt: 9999 }),
      mk({ id: 'clean', cwd: '/clean', lastActiveAt: 10 }),
    ]
    expect(resolveDefaultCwd(sessions)).toBe('/clean')
  })

  it('全部 session cwd 都是脏数据 → undefined（不归入 undefined 组污染）', () => {
    const sessions = [mk({ cwd: '', lastActiveAt: 1 })]
    expect(resolveDefaultCwd(sessions)).toBeUndefined()
  })
})

describe('recentWorkspaces', () => {
  it('空列表 → []（首次启动空态，E4）', () => {
    expect(recentWorkspaces([])).toEqual([])
  })

  it('单 session → 单元素列表', () => {
    const result = recentWorkspaces([mk({ cwd: '/a', lastActiveAt: 1, label: 'A' })])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ cwd: '/a', lastActiveAt: 1, label: 'A' })
  })

  it('多 session 同 cwd → distinct 去重保留 lastActiveAt 最新者（AC-4.6）', () => {
    const sessions = [
      mk({ cwd: '/shared', lastActiveAt: 100, label: 'old' }),
      mk({ cwd: '/shared', lastActiveAt: 500, label: 'new' }),
      mk({ cwd: '/other', lastActiveAt: 300, label: 'other' }),
    ]
    const result = recentWorkspaces(sessions)
    expect(result).toHaveLength(2)
    const shared = result.find((w) => w.cwd === '/shared')
    expect(shared?.lastActiveAt).toBe(500)
    expect(shared?.label).toBe('new')
  })

  it('按 lastActiveAt 倒序排列（AC-4.1）', () => {
    const sessions = [
      mk({ cwd: '/old', lastActiveAt: 100 }),
      mk({ cwd: '/newest', lastActiveAt: 900 }),
      mk({ cwd: '/mid', lastActiveAt: 500 }),
    ]
    const cwds = recentWorkspaces(sessions).map((w) => w.cwd)
    expect(cwds).toEqual(['/newest', '/mid', '/old'])
  })

  it('超过 10 个 distinct cwd → 截断 top10', () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      mk({ id: `s${i}`, cwd: `/r${i}`, lastActiveAt: i }),
    )
    expect(recentWorkspaces(sessions)).toHaveLength(10)
    // 倒序后最活跃的 r14 排首位
    expect(recentWorkspaces(sessions)[0].cwd).toBe('/r14')
  })

  it('cwd 脏数据 → 跳过不进入列表', () => {
    const sessions = [mk({ cwd: '', lastActiveAt: 9999 }), mk({ cwd: '/ok', lastActiveAt: 1 })]
    const result = recentWorkspaces(sessions)
    expect(result).toHaveLength(1)
    expect(result[0].cwd).toBe('/ok')
  })
})
