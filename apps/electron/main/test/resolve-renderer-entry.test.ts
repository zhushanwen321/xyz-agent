/**
 * P0 coexistence spike 测试：resolveRendererEntry（loadFile 入口解析纯函数）。
 *
 * 覆盖 TC1：'1' → dist-new（新壳产物）；undefined/''/'0'/'true'/'2' → dist（原入口，ES1 安全默认）。
 *
 * 纯字符串断言，无 mock。
 *
 * 运行：cd apps/electron/main && npx vitest run test/resolve-renderer-entry.test.ts
 */
import { describe, it, expect } from 'vitest'
import { resolveRendererEntry } from '../window/resolve-renderer-entry.js'

describe('resolveRendererEntry', () => {
  it("'1' 走新壳入口 renderer/dist-new/new-arch/index.html", () => {
    expect(resolveRendererEntry('1')).toBe('renderer/dist-new/new-arch/index.html')
  })

  it('undefined（未设 flag）回落原入口 renderer/dist/index.html（ES1 安全默认）', () => {
    expect(resolveRendererEntry(undefined)).toBe('renderer/dist/index.html')
  })

  it("空串 '' 回落原入口", () => {
    expect(resolveRendererEntry('')).toBe('renderer/dist/index.html')
  })

  it("'0' 回落原入口", () => {
    expect(resolveRendererEntry('0')).toBe('renderer/dist/index.html')
  })

  it("'true'（非 '1' 字符串）回落原入口", () => {
    expect(resolveRendererEntry('true')).toBe('renderer/dist/index.html')
  })

  it("'2'（任意非 '1' 字符串）回落原入口", () => {
    expect(resolveRendererEntry('2')).toBe('renderer/dist/index.html')
  })
})
