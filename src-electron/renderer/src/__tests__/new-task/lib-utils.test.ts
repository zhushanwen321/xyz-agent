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
import { resolveDefaultCwd, recentWorkspaces, deriveSessionLabel } from '@/lib/utils'

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

  it('单 session → 单元素列表（label = cwd basename）', () => {
    const result = recentWorkspaces([mk({ cwd: '/a', lastActiveAt: 1, label: 'A' })])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ cwd: '/a', lastActiveAt: 1, label: 'a' })
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
    // label 取 cwd basename 而非 session label，与去重保留哪条无关
    expect(shared?.label).toBe('shared')
  })

  it('[回归] session 被 rename 后，目录列表 label 仍是目录名（basename），不渗入 session 名', () => {
    // 事故场景：rename 后 session.label 变自定义文本，旧逻辑把它当目录名展示
    const sessions = [
      mk({ cwd: '/foo/bar', lastActiveAt: 100, label: '我的自定义会话名' }),
    ]
    const result = recentWorkspaces(sessions)
    expect(result[0].label).toBe('bar')
    expect(result[0].label).not.toBe('我的自定义会话名')
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

describe('deriveSessionLabel', () => {
  it('空字符串 → 兜底文案『无提示词』', () => {
    expect(deriveSessionLabel('')).toBe('无提示词')
  })

  it('纯空白（空格/换行/Tab）→ trim 后为空 → 兜底文案', () => {
    expect(deriveSessionLabel('   \n\t  ')).toBe('无提示词')
  })

  it('中文 ≤10 字 → 原文（不加省略号）', () => {
    expect(deriveSessionLabel('帮我修复登录')).toBe('帮我修复登录') // 6 字
  })

  it('中文正好 10 字 → 原文（边界，不加省略号）', () => {
    const text = '一二三四五六七八九十' // 正好 10 字
    expect(deriveSessionLabel(text)).toBe(text)
  })

  it('中文 >10 字 → 前 10 字 + 省略号', () => {
    const text = '一二三四五六七八九十十一十二' // 12 字
    expect(deriveSessionLabel(text)).toBe('一二三四五六七八九十…')
  })

  it('英文 >10 字符 → 前 10 字符 + 省略号（按 codePoint，不切断单词边界）', () => {
    const text = 'fix the login bug please'
    expect(deriveSessionLabel(text)).toBe('fix the lo…')
  })

  it('带换行的多行提示词 → trim 后取前 10 字符（换行不进 label）', () => {
    const text = '第一行内容\n第二行内容\n第三行'
    // trim 去首尾空白但不去中间换行；Array.from 按 codePoint，\n 算 1 字
    const expected = Array.from(text.trim()).slice(0, 10).join('') + '…'
    expect(deriveSessionLabel(text)).toBe(expected)
  })

  it('emoji 算 1 字（codePoint 拆分，不按 UTF-16 代理对截断成乱码）', () => {
    const text = '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀' // 12 个 emoji
    expect(deriveSessionLabel(text)).toBe('🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀…')
  })

  it('首尾空白被 trim（前导空格不计入前 10 字符）', () => {
    expect(deriveSessionLabel('     帮我修复登录')).toBe('帮我修复登录')
  })
})
