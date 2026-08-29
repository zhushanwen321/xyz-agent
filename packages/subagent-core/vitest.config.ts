import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for @zhushanwen/subagent-core.
 *
 * Pi SDK packages are aliased to inline mocks (先例：pi-subagent-workflow 包同款)——
 * 随迁测试中 SDK 触点仅两类：format.test.ts 的 visibleWidth 运行时 import（pi-tui）
 * 与 sdk-contract.test.ts 的 vi.mock factory（pi-ai / typebox）。alias 面收窄到本包
 * 实际运行时触点（pi-ai / pi-tui / typebox）；pi-coding-agent 仅剩 import type，
 * 转译擦除后无运行时解析，无需 alias。mocks/ 与 vitest.setup.ts 复制自
 * pi-subagent-workflow 包（u1-move），两包 alias 面不要求等价。
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
