/**
 * path-guard.test.ts — isUnderOrEqual 纯函数安全原语（T1.9）
 *
 * 覆盖：正常子路径、等于、兄弟、.. 穿越、末尾斜杠、相对路径恶意。
 * 核心：`..` 穿越必须返回 false（越界守门安全语义）。
 */
import { describe, it, expect } from 'vitest'
import { isUnderOrEqual } from '../src/path-guard'

describe('isUnderOrEqual', () => {
  const parent = '/a/b'

  it('returns true when child is a normal sub-path', () => {
    expect(isUnderOrEqual(parent, '/a/b/c')).toBe(true)
  })

  it('returns true when child equals parent', () => {
    expect(isUnderOrEqual(parent, parent)).toBe(true)
  })

  it('returns false when child is a sibling', () => {
    expect(isUnderOrEqual(parent, '/a/c')).toBe(false)
  })

  it('returns false for .. traversal escaping parent (core security case)', () => {
    // /a/b/../../../etc/passwd resolves to /etc/passwd — must NOT be under /a/b
    expect(isUnderOrEqual(parent, '/a/b/../../../etc/passwd')).toBe(false)
  })

  it('returns true with trailing slash on parent', () => {
    expect(isUnderOrEqual('/a/b/', '/a/b/c')).toBe(true)
  })

  it('returns false for relative malicious path that resolves outside', () => {
    // /a/b/../b-secret resolves to /a/b-secret — sibling, must not escape detection pass
    expect(isUnderOrEqual(parent, '/a/b/../b-secret')).toBe(false)
  })

  it('handles trailing slash on child equal to parent', () => {
    expect(isUnderOrEqual('/a/b', '/a/b/')).toBe(true)
  })

  it('returns true for deeper nesting', () => {
    expect(isUnderOrEqual(parent, '/a/b/c/d/e')).toBe(true)
  })

  it('returns false for unrelated absolute path', () => {
    expect(isUnderOrEqual(parent, '/x/y/z')).toBe(false)
  })

  it('returns false when child is the parent of given parent', () => {
    // /a is a parent of /a/b, so /a is NOT under-or-equal /a/b
    expect(isUnderOrEqual(parent, '/a')).toBe(false)
  })
})
