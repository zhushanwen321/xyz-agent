// engines-declaration.test.ts —— [U7b] 双源一致性守护：package.json 的
// xyz-agent.subagentEngines 静态声明（runtime 冷启动回退源）必须与代码注册表一致。
// 新增引擎时改注册点 + 声明两处；漏改声明会被本测试拦截（冷启动 GUI 将少列引擎）。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// package.json 与 src/ 的相对位置（本文件在 src/execution/engine/__tests__/ 下，四级上溯）
const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");

describe("package.json xyz-agent.subagentEngines 静态声明一致性（U7b 冷启动回退源）", () => {
  it("声明存在、非空、全为字符串", () => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      "xyz-agent"?: { subagentEngines?: unknown };
    };
    const declared = pkg["xyz-agent"]?.subagentEngines;
    expect(Array.isArray(declared)).toBe(true);
    expect((declared as string[]).length).toBeGreaterThan(0);
    expect((declared as unknown[]).every((e) => typeof e === "string")).toBe(true);
  });

  it("与组合根注册的引擎一致（registerPiEngine/registerZcodeEngine 后 listEngines 等值）", async () => {
    // 直接 import 组合根注册模块（工厂体同款调用），再对 listEngines——不 import index.ts
    // 全量工厂（避免拉起 ExtensionAPI 依赖面），注册点即一致性的代码侧事实源。
    await import( "@zhushanwen/subagent-core/execution/engine/engines/pi/registration.ts").then((m) => m.registerPiEngine());
    await import( "@zhushanwen/subagent-core/execution/engine/engines/zcode/registration.ts").then((m) => m.registerZcodeEngine());
    const { listEngines } = await import( "@zhushanwen/subagent-core/execution/engine/registry.ts");

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { "xyz-agent"?: { subagentEngines?: string[] } };
    const declared = pkg["xyz-agent"]?.subagentEngines ?? [];
    expect([...declared].sort()).toEqual([...listEngines()].sort());
  });
});
