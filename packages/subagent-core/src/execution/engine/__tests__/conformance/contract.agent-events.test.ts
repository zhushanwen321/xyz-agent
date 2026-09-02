// contract.agent-events.test.ts —— conformance C3（AgentEvent 不变量）+ 负例自证
// （A12「套件有牙」：故意破坏一个不变量的样本必须被断言器检出——用「注入坏
// parser」的形态：wrap 真实 synthesizeCoarseEvents 抽掉 message_end，断言套件转红；
// 若断言器检不出破坏则本元测试失败）。
//
// [R6] 双模式口径：zcode 引擎 conformance 覆盖两种通道形态——spawn 钉扎（golden
// stdout 语料 + coarse 合成，下方原有用例）与 app-server 常驻（fake 常驻引擎全链 +
// stream 口径，文件末新增 describe；app-server 设计 §3.4 不变量 1：text_delta 拼接 ==
// read 全文、终态唯一 turn.terminal 权威、message_end.usage 完整、tool 事件不合成
// ——granularity 声明与实际流出一致）。

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../types.ts";
import { ZCODE_APPSERVER_GOLDEN, ZCODE_GOLDEN_STDOUT } from "../../engines/zcode/golden-sample.ts";
import { ZCODE_APPSERVER_POOL_KEY } from "../../engines/zcode/constants.ts";
import { parseZcodeTerminal, synthesizeCoarseEvents } from "../../engines/zcode/parser.ts";
import {
  goldenReadFullText,
  makeAppserverHarness,
} from "./zcode-appserver-harness.ts";
import {
  assertAgentEventInvariants,
  checkAgentEventInvariants,
} from "./agent-event-invariants.ts";

/** golden 实录的 coarse 事件流（真实 parser + 真实合成器的产出）。 */
function goldenCoarseEvents(): AgentEvent[] {
  const terminal = parseZcodeTerminal(ZCODE_GOLDEN_STDOUT);
  if (!terminal.ok) throw new Error("golden 样本解析失败");
  return synthesizeCoarseEvents(terminal.payload.response, terminal.payload.usage);
}

describe("conformance C3：AgentEvent 不变量（真实 parser 产出全绿）", () => {
  it("zcode golden 合成事件满足五条不变量（coarse 口径）", () => {
    assertAgentEventInvariants(goldenCoarseEvents(), { granularity: "coarse" });
  });

  it("不变量 1：终态唯一——turn_end 后不得再出现非 error 事件", () => {
    const events: AgentEvent[] = [{ type: "message_end" }, { type: "turn_end" }, { type: "text_delta", delta: "x" }];
    const findings = checkAgentEventInvariants(events, { granularity: "coarse" });
    expect(findings.some((f) => f.invariant === "1")).toBe(true);
  });

  it("不变量 2：message_end.usage 残缺对象（NaN token）被判违例", () => {
    const events: AgentEvent[] = [
      { type: "message_end", usage: { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { type: "turn_end" },
    ];
    const findings = checkAgentEventInvariants(events, { granularity: "coarse" });
    expect(findings.some((f) => f.invariant === "2")).toBe(true);
  });

  it("不变量 2 正例：usage 显式缺省整个字段 = 合法（不给残缺）", () => {
    const events: AgentEvent[] = [{ type: "message_end" }, { type: "turn_end" }];
    expect(checkAgentEventInvariants(events, { granularity: "coarse" })).toEqual([]);
  });

  it("不变量 3a：流式 text_delta 拼接 ≠ content 判违例（byte 级）", () => {
    const events: AgentEvent[] = [
      { type: "text_delta", delta: "abc" },
      { type: "message_end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { type: "turn_end" },
    ];
    const findings = checkAgentEventInvariants(events, { granularity: "stream", content: "abd" });
    expect(findings.some((f) => f.invariant === "3a")).toBe(true);
  });

  it("不变量 3b：coarse 序列缺 message_end（turn_end 裸终态）判违例", () => {
    const events: AgentEvent[] = [{ type: "turn_end" }];
    const findings = checkAgentEventInvariants(events, { granularity: "coarse" });
    expect(findings.some((f) => f.invariant === "3b")).toBe(true);
  });

  it("不变量 4：未配对 tool_start 且无 error 兜底判违例；error 兜底合法", () => {
    const unpaired: AgentEvent[] = [
      { type: "tool_start", toolName: "bash" },
      { type: "turn_end" },
    ];
    expect(checkAgentEventInvariants(unpaired, { granularity: "coarse" }).some((f) => f.invariant === "4")).toBe(true);

    const withError: AgentEvent[] = [
      { type: "tool_start", toolName: "bash" },
      { type: "error", message: "boom" },
      { type: "turn_end" },
    ];
    expect(checkAgentEventInvariants(withError, { granularity: "coarse" }).some((f) => f.invariant === "4")).toBe(false);
  });
});

describe("conformance 负例自证（A12：套件有牙）", () => {
  it("注入坏 parser（抽掉 message_end 的合成器）：断言器必须检出（不变量 3b 转红）", () => {
    // 坏 parser 形态：zcode 新版本漂移后合成器丢 message_end——不变量 3b 应抓到
    const badParser = (): AgentEvent[] => [{ type: "turn_end" }];
    const events = badParser();
    const findings = checkAgentEventInvariants(events, { granularity: "coarse" });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.invariant === "3b")).toBe(true);
    // 断言形态同步转红（conformance 用例消费的入口）
    expect(() => assertAgentEventInvariants(events, { granularity: "coarse" })).toThrowError(/不变量/);
  });

  it("注入坏 parser（usage 半映射）：断言器必须检出（不变量 2 转红）", () => {
    // 坏 parser 形态：新版本 usage 字段改名，数值映射 Number(undefined) → NaN 渗入
    const badParser = (): AgentEvent[] => [
      { type: "message_end", usage: { input: Number.NaN, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { type: "turn_end" },
    ];
    const findings = checkAgentEventInvariants(badParser(), { granularity: "coarse" });
    expect(findings.some((f) => f.invariant === "2")).toBe(true);
  });
});

// ============================================================
// [R6] C3 app-server 口径：fake 常驻引擎全链（eventGranularity=stream 形态）
// —— spawn 钉扎用例见上方 coarse describe，两形态各自覆盖不合并（D2 降级链保留
// spawn 路径，双通道都是生产可达形态）。
// ============================================================

describe("conformance C3：zcode app-server 常驻通道（stream 口径，fake 常驻全链）", () => {
  it("text_delta 拼接 == read 全文（byte 级）+ 终态唯一 + message_end.usage 完整 + tool 事件不合成", async () => {
    const h = makeAppserverHarness();
    try {
      const events: AgentEvent[] = [];
      const { outcome } = await h.engine.run(
        { task: "做点什么", slug: "c3-appserver", model: "conformance-provider/m1", cwd: h.workspace },
        { taskId: "sa-c3-appserver", poolKey: "", onEvent: (e) => events.push(e) },
      );

      // granularity 声明与实际流出一致：声明 stream，流出有 text_delta 实时形态
      expect(h.engine.capabilities().eventGranularity).toBe("stream");
      expect(events.some((e) => e.type === "text_delta")).toBe(true);

      // 事件形态：三条 delta（golden pushStream）→ message_end(usage) → turn_end
      expect(events.map((e) => e.type)).toEqual([
        "text_delta", "text_delta", "text_delta", "message_end", "turn_end",
      ]);
      const messageEnd = events.find((e) => e.type === "message_end") as
        | { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }
        | undefined;
      expect(messageEnd?.usage).toEqual({ input: 12599, output: 17, cacheRead: 0, cacheWrite: 0 });

      // tool 事件不合成：首期无逐工具推送帧，流出面不伪造 tool_start/tool_end
      // （granularity 声明与实际流出一致即合法——app-server 设计 §3.4 不变量 1）
      expect(events.some((e) => e.type === "tool_start" || e.type === "tool_end")).toBe(false);

      // 不变量五条（stream 口径）：3a 的 content 用 read 全文（终态权威来源）
      const readFullText = goldenReadFullText();
      assertAgentEventInvariants(events, { granularity: "stream", content: readFullText });
      expect(outcome.content).toBe(readFullText);
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it("终态权威 turn.terminal 缺失 → read 兜底收口，事件不变量仍全绿（宽松匹配防洪堤不破坏 C3）", async () => {
    const h = makeAppserverHarness({ dropTurnTerminal: true });
    try {
      const events: AgentEvent[] = [];
      const { outcome } = await h.engine.run(
        { task: "做点什么", slug: "c3-no-terminal", model: "conformance-provider/m1", cwd: h.workspace },
        { taskId: "sa-c3-no-terminal", poolKey: "", onEvent: (e) => events.push(e) },
      );
      expect(outcome.error).toBeUndefined();
      // 缺 turn.terminal 时收尾帧 + read 兜底仍产出完整终态（session-channel 宽松匹配）
      assertAgentEventInvariants(events, { granularity: "stream", content: goldenReadFullText() });
    } finally {
      await h.dispose();
    }
  }, 20_000);

  it("handle 锚定常驻 HOME（poolKey=home-appserver，①级读取钥匙随 handle 走）", async () => {
    const h = makeAppserverHarness();
    try {
      const { handle, outcome } = await h.engine.run(
        { task: "做点什么", slug: "c3-anchor", model: "conformance-provider/m1", cwd: h.workspace },
        { taskId: "sa-c3-anchor", poolKey: "" },
      );
      expect(handle.data.poolKey).toBe(ZCODE_APPSERVER_POOL_KEY);
      expect(handle.data.sessionRef["sessionId"]).toBe(outcome.sessionId);
      // golden 锚点：sessionId 来自 session.sessionId（projection.sessionId 恒 "unknown" 勿用）
      expect(JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse).session.sessionId).toBe("sess_golden_r3_01");
    } finally {
      await h.dispose();
    }
  }, 20_000);
});
