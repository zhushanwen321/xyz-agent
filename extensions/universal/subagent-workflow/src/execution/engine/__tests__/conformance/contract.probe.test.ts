// contract.probe.test.ts —— conformance C1（probe 形状）：ProbeReport 字段完整；
// ok=false 时 error.recovery 非空（§3.3.5——恢复指引是错误闭环「错误→权威源→重试」
// 的载体，空指引 = 拦截了但不知道怎么修）。pi/zcode 双引擎都过（任何 adapter 必过）。
//
// fake 注入（不依赖真机）：pi 用 probeVersion fake + 不可解析 invocation 场景；
// zcode 用不存在的 cliPath 构造 binary check 失败。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PiEngine } from "../../engines/pi/pi-engine.ts";
import { ZcodeEngine } from "../../engines/zcode/zcode-engine.ts";
import type { ProbeReport } from "../../types.ts";

function assertProbeShape(report: ProbeReport): void {
  expect(typeof report.ok).toBe("boolean");
  expect(typeof report.engineVersion).toBe("string");
  expect(Array.isArray(report.checks)).toBe(true);
  expect(report.checks.length).toBeGreaterThan(0);
  for (const c of report.checks) {
    expect(typeof c.name).toBe("string");
    expect(typeof c.ok).toBe("boolean");
  }
  if (!report.ok) {
    expect(report.error).toBeDefined();
    expect(report.error?.code).toBe("engine_probe_failed");
    // 恢复指引非空且指向动作（C1 断言核心——空指引直接 fail）
    expect(report.error?.recovery).toBeTruthy();
    expect(report.error?.recovery.length).toBeGreaterThan(20);
  }
}

describe("conformance C1：probe 形状（ProbeReport 字段完整 + 失败含恢复指引）", () => {
  it("pi：成功路径形状（fake 版本探测，不 spawn 真进程）", async () => {
    const engine = new PiEngine({ getService: () => null, probeVersion: async () => "0.84.1" });
    const report = await engine.probe();
    assertProbeShape(report);
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toBe("0.84.1");
  });

  it("pi：失败路径（invocation 不可解析）——error.recovery 非空", async () => {
    const engine = new PiEngine({
      getService: () => null,
      probeVersion: async () => undefined,
    });
    // PATH 无 pi 时 invocation check 失败；有 pi 时版本 fake 失败——两形态都走断言器
    const report = await engine.probe({ force: true });
    assertProbeShape(report);
  });

  it("zcode：成功路径形状（存在的 cliPath + fake 版本探测）", async () => {
    const engine = new ZcodeEngine({
      engineDataDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "probe-zcode-")),
      cliPath: fileURLToPath(import.meta.url),
      probeVersion: async () => "0.16.5",
    });
    const report = await engine.probe();
    assertProbeShape(report);
    expect(report.ok).toBe(true);
  });

  it("zcode：失败路径（二进制不存在）——error.recovery 非空且含重探指引", async () => {
    const engine = new ZcodeEngine({
      engineDataDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "probe-zcode-")),
      cliPath: "/nonexistent/zcode.cjs",
    });
    const report = await engine.probe();
    assertProbeShape(report);
    expect(report.ok).toBe(false);
    expect(report.error?.recovery).toContain("--version");
  });
});
