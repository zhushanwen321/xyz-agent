/**
 * summarizeTurnForRail 纯函数测试（TC-w3-9 / TC-w3-10，w3 wave）。
 *
 * 覆盖 IF5 契约：
 * - TC-w3-9：markdown 富文本 → 剥标记 + 截断到 20 字纯文本
 * - TC-w3-10：user=null → 空串
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/logic/__tests__/summarizeTurn.test.ts
 */
import { describe, it, expect } from 'vitest'
import { summarizeTurnForRail } from '../summarizeTurn'
import type { MessageTurn } from '../messageTurns'

/** 构造最小可用的 MessageTurn（用 as 断言绕开完整 Message 字段需求）。 */
function makeTurn(userContent: string | null): MessageTurn {
  return {
    index: 1,
    user:
      userContent === null
        ? null
        : ({ id: 'u1', role: 'user', content: userContent, status: 'done' } as MessageTurn['user']),
    assistants: [],
    isStreaming: false,
    hasFoldable: false,
  } as MessageTurn
}

describe('summarizeTurnForRail (IF5)', () => {
  it('TC-w3-9: 剥离 markdown 标记后取前 20 字纯文本', () => {
    // 标题 + 加粗 + 链接 + 行内代码混合
    const turn = makeTurn('# 修复 **trace** 渲染 [bug](https://x.com) `code`')
    const summary = summarizeTurnForRail(turn)
    // 预期：# / ** / [bug](url) / ` 全部剥离，纯文本 = "修复 trace 渲染 bug code"
    expect(summary).toBe('修复 trace 渲染 bug code')
    // 长度上限校验：短文本不加省略号
    expect(summary.length).toBeLessThanOrEqual(20)
  })

  it('TC-w3-9b: 超长文本截断到 20 字 + 省略号', () => {
    const longText = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
    // 30 字符的中文串，应截到 19 字 + '…' = 20 字符
    const summary = summarizeTurnForRail(makeTurn(longText))
    expect(summary.length).toBe(20)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.startsWith('一二三四五六七八九十一二三四五六七八九')).toBe(true)
  })

  it('TC-w3-10: user 为 null 时返回空串', () => {
    expect(summarizeTurnForRail(makeTurn(null))).toBe('')
  })
})
