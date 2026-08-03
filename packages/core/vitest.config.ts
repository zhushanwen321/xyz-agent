import { defineConfig } from 'vitest/config'

// core 是平台无关内核（headless），零 DOM。测试用 node 环境跑纯逻辑编排（bootstrap 时序/ES1 中断）。
// 无 vue plugin、无 happy-dom、无 coverage threshold（P0 骨架阶段，覆盖率随 P3 域迁移滚动校准）。
export default defineConfig({
  test: {
    environment: 'node',
  },
})
