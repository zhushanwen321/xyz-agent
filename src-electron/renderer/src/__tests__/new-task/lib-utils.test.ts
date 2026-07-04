/**
 * lib/utils 纯函数单测 —— deriveSessionLabel（W3 后仅保留 cn + deriveSessionLabel）。
 *
 * 覆盖：
 * - deriveSessionLabel：空字符串/纯空白/中文/英文/多行/emoji/省略号
 *
 * 注：resolveDefaultCwd / recentWorkspaces 已迁移到 workspaceStore（W3），
 * 相关测试见 workspace-store.test.ts。
 *
 * mock 策略：纯函数无外部依赖，直接 import 断言，无 mock。
 *
 * 运行：cd src-electron/renderer && npx vitest run src/__tests__/new-task/lib-utils.test.ts
 */
import { describe, it, expect } from 'vitest'
import { deriveSessionLabel } from '@/lib/utils'

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
