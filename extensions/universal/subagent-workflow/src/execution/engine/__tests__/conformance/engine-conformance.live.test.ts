// engine-conformance.live.test.ts —— conformance run 层（真实 spawn 简单任务，C2/C4
// 真机面）。手动门（设计 §3.3.8：run 层需已装引擎 + 有效凭据，不进默认 CI）：
//
//   cd extensions/universal/subagent-workflow
//   ENGINE_CONFORMANCE_LIVE=1 pnpm vitest run src/execution/engine/__tests__/conformance/engine-conformance.live.test.ts
//
// pi 部分复用 PiEngine 的服务面注入（真实 executeAndAwait 需要完整 SubagentService 装配，
// live 场景从进程单例取——未初始化时该用例 skip 并说明）；zcode 部分与 P3 的
// zcode-engine.live.test.ts 互补（后者已覆盖 schema 全链，此处只跑 conformance 最小面）。

import { describe, expect, it } from "vitest";

import { getSubagentService } from "../../../subagent-service.ts";
import { ZcodeEngine } from "../../engines/zcode/zcode-engine.ts";
import { createPiEngine } from "../../engines/pi/registration.ts";
import type { RunContext } from "../../port.ts";
import type { AgentTaskSpec } from "../../types.ts";

const LIVE = process.env["ENGINE_CONFORMANCE_LIVE"] === "1";

describe.skipIf(!LIVE)("conformance run 层（真实 spawn，手动门）", () => {
  it("pi：简单任务全链（C2：outcome 无 error、content 非空、engineId=pi）", async (testCtx) => {
    const service = getSubagentService();
    if (service === null) {
      // 服务装配是 pi live 的前置（完整 SubagentService + modelRegistry 注入）——
      // live 门内说明跳过原因而非静默 pass（失败要出声）
      testCtx.skip("SubagentService 未装配（需在真实会话进程内运行）");
      return;
    }
    const engine = createPiEngine(() => service);
    const task: AgentTaskSpec = { task: "Reply with the single word: ok", slug: "live-c2" };
    const ctx: RunContext = { taskId: "sa-live-pi-c2", poolKey: "shared" };
    const { outcome } = await engine.run(task, ctx);
    expect(outcome.error).toBeUndefined();
    expect(outcome.content.trim().length).toBeGreaterThan(0);
    expect(outcome.engineId).toBe("pi");
  }, 120_000);

  it("zcode：probe 真机（C1 live 面：三项 check 全过）", async () => {
    const engine = new ZcodeEngine({ engineDataDir: () => "/tmp/zcode-conformance-live" });
    const report = await engine.probe();
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toMatch(/^0\.\d+\.\d+$/);
  }, 60_000);
});
