import { defineConfig } from 'vitest/config'

// main 进程纯函数测试。
// main/ 不在 workspace 包内（非 renderer/runtime/shared），但 vitest 已 hoist 到根 node_modules，
// @xyz-agent/shared 经 workspace symlink 解析。仅测无 electron 运行时依赖的纯函数。
export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    // ../scripts/__tests__：dev-instance-lib 纯函数层（MF-8，C-build-08 装配器可测层），
    // 同样无 electron 运行时依赖，随 main 纯函数测试一起跑。
    include: ['test/**/*.test.ts', '**/__tests__/**/*.test.ts', '../scripts/__tests__/**/*.test.mjs'],
  },
})
