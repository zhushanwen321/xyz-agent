import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for @zhushanwen/pi-subagent-workflow.
 *
 * External Pi SDK packages are aliased to inline mocks or shared type stubs
 * so that vitest's module resolution succeeds without the real packages installed.
 */
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    // [F-R5] 每个测试文件加载前统一删三个 watchdog env（watchdog 预算语义默认关），
    // 根治宿主 shell export 导致的假红；用例内 vi.stubEnv 仍照常叠加生效。
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent": path.resolve(__dirname, "mocks/pi-coding-agent.ts"),
      "@earendil-works/pi-ai": path.resolve(__dirname, "mocks/pi-ai.ts"),
      "@earendil-works/pi-tui": path.resolve(__dirname, "mocks/pi-tui.ts"),
      "typebox": path.resolve(__dirname, "mocks/typebox.ts"),
      "@zhushanwen/pi-structured-output": path.resolve(__dirname, "../structured-output/src/index.ts"),
    },
  },
});
