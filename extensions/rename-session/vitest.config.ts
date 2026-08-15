import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/*.test.mjs：E2E harness 断言纯函数单测（无网络/无进程 spawn，随单测一起跑）；
    // 场景脚本 run-aN.mjs 不匹配该 pattern，不会被 vitest 误收
    include: ["src/__tests__/**/*.test.ts", "e2e/*.test.mjs"],
  },
});
