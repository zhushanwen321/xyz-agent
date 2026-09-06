// contract.abort.test.ts —— conformance C4（abort 行为）：运行中 cancel → 宿主合成
// 终态（exitCode=null）、无悬挂 promise（run 正常 resolve、exited 收口）、错误事件
// 先于终态 emit（不变量 5 的事件面）。fake app-server 注入（不依赖真机）。
//
// 2026-09 重构（共享宿主 HOME）：CLI spawn 降级链删除后引擎只剩 app-server 常驻链，
// abort 用例只覆盖常驻形态（fake-appserver.mjs 挂起场景，stop 链优先于杀链——D3）。
// capabilities.interrupt 维持 kill-only 声明（D5——改链路先于改声明，stop 链路经
// conformance 真机验证后再评估升 native）。

import { describe, expect, it, vi } from "vitest";

import type { AgentCallOpts } from "../../../../orchestration/models/types.ts";
import type { RunContext } from "../../port.ts";
import type { AgentEvent } from "../../types.ts";
import { makeAppserverHarness, sentMethodNames } from "./zcode-appserver-harness.ts";

describe("conformance C4：abort 行为（运行中 cancel → 合成终态、无悬挂）", () => {
  // app-server 常驻形态：abort 走 D3 链（stop → grace → killChain）。挂起场景
  // （只推 state.updated，turn 永不落定）+ stopBehavior 缺省 terminal = stop 优雅
  // 生效路径——不杀共享进程，run 正常 resolve（C4 的常驻通道面）。
  it("app-server 模式：abort → stop 帧先发 → 优雅收口（run resolve、exitCode=null、error 事件先于终态、kill-only 声明维持）", async () => {
    const h = makeAppserverHarness({ hangOnly: true });
    try {
      // capabilities.interrupt 维持 kill-only（D5——升级序里 interrupt 不动）
      expect(h.engine.capabilities().interrupt).toBe("kill-only");

      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const ctx: RunContext = {
        taskId: "sa-c4-appserver",
        poolKey: "",
        signal: controller.signal,
        onEvent: (e) => events.push(e),
      };
      // D6 合流后单一任务形状 AgentCallOpts（prompt≡原 task、description≡原 slug 源）
      const task: AgentCallOpts = {
        prompt: "hang",
        description: "abort-appserver",
        model: "conformance-provider/m1",
        cwd: h.workspace,
      };
      const runP = h.engine.run(task, ctx);
      // 推进到 send 已达（create+send 帧落 fake 流水）再 abort——abort 先于 create 会
      // 走 pre-aborted 短路面，覆盖不到 stop 链
      await vi.waitFor(
        () => expect(sentMethodNames(h.stateFile)).toContain("session/send"),
        { timeout: 5_000 },
      );
      controller.abort();
      const { outcome } = await runP; // 必须正常 resolve（stop 优雅收口，不悬挂）

      expect(outcome.exitCode).toBeNull();
      expect(outcome.error).toContain("session/stop");
      // 错误事件先于终态 emit（不变量 5 的事件面——journal 可重放出失败事实）。abort
      // 终态不合成 turn_end（只断言 error 事件到达，且其后无任何非 error 事件流出）
      const errorIdx = events.findIndex((e) => e.type === "error");
      expect(errorIdx).toBeGreaterThanOrEqual(0);
      expect(events.slice(errorIdx + 1).every((e) => e.type === "error")).toBe(true);
      // D3 序：stop 帧先于任何杀链动作（优雅路径下进程未被杀）
      const methods = sentMethodNames(h.stateFile);
      expect(methods.indexOf("session/stop")).toBeGreaterThan(methods.indexOf("session/send"));
    } finally {
      await h.dispose();
    }
  }, 20_000);
});
