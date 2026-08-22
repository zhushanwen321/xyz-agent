/**
 * session-manager extension 基础测试。
 */
import { describe, it, expect } from 'vitest'

describe('session-manager extension', () => {
  it('extension 入口存在', async () => {
    const mod = await import('../index.js')
    expect(mod.default).toBeDefined()
    expect(mod.default.name).toBe('session-manager')
  })
})
