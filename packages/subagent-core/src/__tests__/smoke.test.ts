import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_VERSION } from "../index";

// 版本双源一致性（与仓根 scripts/check-subagent-core-closure.mjs 检查项 0 同判据）：
// 原字面量断言 "0.1.0" 是 scaffold 初版遗留，基线 bump 到 0.2.0 后失守——改为
// 动态读 package.json，发版零维护。
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("subagent-core scaffold smoke", () => {
  it("exposes CORE_PACKAGE_VERSION, in sync with package.json version", () => {
    expect(CORE_PACKAGE_VERSION).toBe(pkg.version);
  });
});
