import { describe, expect, it } from 'vitest'

// jsdom 环境冒烟测试：验证 vitest.config.ts 的 environment: 'jsdom' 生效
//（scaffold 阶段无逻辑代码，此测试守卫测试环境配置本身）。
describe('dom-core jsdom environment', () => {
  it('document is available (jsdom environment active)', () => {
    const el = document.createElement('div')
    expect(el.tagName).toBe('DIV')
  })
})
