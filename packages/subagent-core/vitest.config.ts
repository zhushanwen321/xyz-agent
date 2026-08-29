import { defineConfig } from 'vitest/config'

// 骨架期仅 smoke；代码迁移（u1-move）后随迁测试经同一配置运行。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
