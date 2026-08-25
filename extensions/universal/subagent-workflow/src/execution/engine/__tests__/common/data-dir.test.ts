// data-dir.test.ts —— dataDir 通道解析（XYZ_AGENT_DATA_DIR 权威通道 + piAgentDir 回退）。
//
// 三视角：①构建者——两级解析顺序正确；②使用者——独立 pi 用户（无 xyz env）拿到
// piAgentDir 作根；③观察者——回退路径 warn 一次（不留静默漂移），不刷屏。
//
// 注意：getAgentDir 在 vitest 下 alias 到 mocks/pi-coding-agent.ts（返回
// /home/user/.pi/agent）——本测试只断言两级解析顺序与 warn 行为，不测 pi SDK 内部。

import { beforeEach, describe, expect, it } from "vitest";

import { getEngineDataDir, resetDataDirWarnForTests, XYZ_DATA_DIR_ENV } from "../../common/data-dir.ts";

beforeEach(() => {
  resetDataDirWarnForTests();
});

describe("getEngineDataDir", () => {
  it("XYZ_AGENT_DATA_DIR 存在 → 权威通道直取，不 warn", () => {
    const warnings: string[] = [];
    const dir = getEngineDataDir({ [XYZ_DATA_DIR_ENV]: "/data/xyz-agent" }, (m) => warnings.push(m));
    expect(dir).toBe("/data/xyz-agent");
    expect(warnings).toEqual([]);
  });

  it("空串/空白串视为缺失（truthy 语义与 shared getDataDir 的 || 归一对齐）", () => {
    const warnings: string[] = [];
    const dir = getEngineDataDir({ [XYZ_DATA_DIR_ENV]: "   " }, (m) => warnings.push(m));
    expect(dir).not.toBe("   ");
    expect(warnings.length).toBe(1);
  });

  it("缺 env → 回退 piAgentDir（getAgentDir()，mock 值）并 warn 一次", () => {
    const warnings: string[] = [];
    const warn = (m: string): void => warnings.push(m);
    const dir1 = getEngineDataDir({}, warn);
    expect(dir1).toBe("/home/user/.pi/agent"); // vitest mock 的 getAgentDir
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("XYZ_AGENT_DATA_DIR");

    // warn once：第二次调用不再刷
    const dir2 = getEngineDataDir({}, warn);
    expect(dir2).toBe(dir1);
    expect(warnings.length).toBe(1);
  });

  it("reset 后再次回退会重新 warn（测试隔离钩子可用）", () => {
    const warnings: string[] = [];
    getEngineDataDir({}, (m) => warnings.push(m));
    resetDataDirWarnForTests();
    getEngineDataDir({}, (m) => warnings.push(m));
    expect(warnings.length).toBe(2);
  });
});
