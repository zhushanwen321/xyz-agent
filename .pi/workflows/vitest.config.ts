import { defineConfig } from "vitest/config";

// vitest 配置：覆盖 recursive-split-utils.cjs 的纯逻辑单元测试。
// 独立于 extensions/subagent-workflow 的 vitest 配置——那个测 extension 代码，这个测 workflow 编排逻辑。
export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
  },
});
