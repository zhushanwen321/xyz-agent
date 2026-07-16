/**
 * composables/logic/path 纯函数单测（dirNameOf / parentDirNameOf）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/path.test.ts
 */
import { describe, it, expect } from 'vitest'
import { dirNameOf, parentDirNameOf } from '@/composables/logic/path'

describe('dirNameOf —— 取末段目录名（basename）', () => {
  it('常规绝对路径 → 末段', () => {
    expect(dirNameOf('/Users/foo/bar')).toBe('bar')
    expect(dirNameOf('/Code/xyz-agent')).toBe('xyz-agent')
  })

  it('尾斜杠 / 连续斜杠 → 兼容（filter 空段）', () => {
    expect(dirNameOf('/Users/foo/bar/')).toBe('bar')
    expect(dirNameOf('/Users//foo/bar')).toBe('bar')
  })

  it('根路径或空串 → 无段，回退原串', () => {
    expect(dirNameOf('/')).toBe('/')
    expect(dirNameOf('')).toBe('')
  })

  it('相对路径无分隔符 → 原串', () => {
    expect(dirNameOf('foo')).toBe('foo')
  })
})

describe('parentDirNameOf —— 取上级段名（同名目录消歧用）', () => {
  it('多段路径 → 倒数第二段', () => {
    expect(parentDirNameOf('/Code/chat_project')).toBe('Code')
    expect(parentDirNameOf('/Users/foo/Stock/chat_project')).toBe('Stock')
  })

  it('尾斜杠 → filter 后同结果', () => {
    expect(parentDirNameOf('/Code/chat_project/')).toBe('Code')
  })

  it('单段路径 → 空串（无法消歧，调用方据此不追加）', () => {
    expect(parentDirNameOf('/chat_project')).toBe('')
    expect(parentDirNameOf('chat_project')).toBe('')
  })

  it('根路径或空串 → 空串', () => {
    expect(parentDirNameOf('/')).toBe('')
    expect(parentDirNameOf('')).toBe('')
  })
})
