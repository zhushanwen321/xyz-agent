import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for @zhushanwen/subagent-core.
 *
 * Pi SDK packages are aliased to inline mocks (先例：pi-subagent-workflow 包同款)——
 * 随迁测试中 SDK 触点仅两类：format.test.ts 的 visibleWidth 运行时 import（pi-tui）
 * 与 sdk-contract.test.ts 的 vi.mock factory（pi-ai / typebox）。mocks/ 与
 * vitest.setup.ts 复制自 pi-subagent-workflow 包（u1-move），保持两包测试环境等价。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // 对齐壳侧 F-R5：每个测试文件加载前删 watchdog 三 env，防宿主 shell export 假红。
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@earendil-works/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@earendil-works/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "typebox": path.resolve(__dirname, "mocks/typebox.ts"),
    },
  },
});
