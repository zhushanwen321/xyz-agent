import { defineConfig } from 'vitest/config'

// main 进程纯函数测试。
// main/ 不在 workspace 包内（非 renderer/runtime/shared），但 vitest 已 hoist 到根 node_modules，
// @xyz-agent/shared 经 workspace symlink 解析。仅测无 electron 运行时依赖的纯函数。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
