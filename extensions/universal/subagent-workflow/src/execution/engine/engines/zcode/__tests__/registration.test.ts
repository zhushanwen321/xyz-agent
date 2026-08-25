// registration.test.ts —— 注册表接线（验收 6）：'zcode' 可经 getEngine 获取、幂等
// 覆盖、engineDataDir 默认走 common/data-dir SSOT。clearEngines 隔离全局注册表状态。

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { afterEach, describe, expect, it, vi } from "vitest";

import { clearEngines, getEngine, hasEngine, listEngines } from "../../../registry.ts";
import { createZcodeEngine, registerZcodeEngine } from "../registration.ts";

afterEach(() => {
  clearEngines();
  vi.restoreAllMocks();
});

describe("registerZcodeEngine", () => {
  it("登记后 getEngine('zcode') 可用，id/capabilities 正确", () => {
    registerZcodeEngine(() => "/tmp/data");
    expect(hasEngine("zcode")).toBe(true);
    expect(listEngines()).toContain("zcode");
    const engine = getEngine("zcode");
    expect(engine.id).toBe("zcode");
    expect(engine.capabilities().schemaEnforcement).toBe("emulated");
  });

  it("幂等：重复注册覆盖不堆积（listEngines 单条）", () => {
    registerZcodeEngine(() => "/tmp/data");
    registerZcodeEngine(() => "/tmp/data2");
    expect(listEngines().filter((id) => id === "zcode")).toHaveLength(1);
    // 覆盖后单例按新工厂重建（engineDataDir 已换）
    expect(hasEngine("zcode")).toBe(true);
  });

  it("createZcodeEngine DI 工厂：deps 直达引擎", () => {
    const engine = createZcodeEngine({ engineDataDir: () => "/tmp/x" });
    expect(engine.id).toBe("zcode");
  });
});

describe("engineDataDir 默认通道（common/data-dir SSOT）", () => {
  it("缺省经 getEngineDataDir 解析：env 优先，缺失回落 piAgentDir（warn 一次）", async () => {
    // warn 断言走 getEngineDataDir 自带的 DI warn 参数——缺省 warn 通道是
    // pi-extension-logger（落文件，不经 console.warn，见 data-dir.ts defaultWarn），
    // spy console 永远收不到且会让 logger 落文件产生测试副作用。
    const { getEngineDataDir, resetDataDirWarnForTests } = await import("../../../common/data-dir.ts");
    const warns: string[] = [];
    const prev = process.env["XYZ_AGENT_DATA_DIR"];
    delete process.env["XYZ_AGENT_DATA_DIR"];
    try {
      resetDataDirWarnForTests();
      // 回退分支：无 env → getAgentDir()（vitest alias mock）+ warn 一次
      expect(getEngineDataDir(process.env, (m) => warns.push(m))).toBe(getAgentDir());
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("XYZ_AGENT_DATA_DIR");
      // env 分支：显式注入即取 env 值（透传链证据见 common/data-dir.ts 文件头）
      process.env["XYZ_AGENT_DATA_DIR"] = "/from-host";
      expect(getEngineDataDir(process.env, (m) => warns.push(m))).toBe("/from-host");
      expect(warns).toHaveLength(1);
    } finally {
      if (prev !== undefined) process.env["XYZ_AGENT_DATA_DIR"] = prev;
      else delete process.env["XYZ_AGENT_DATA_DIR"];
    }
  });
});
