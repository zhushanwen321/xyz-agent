// capability-gate.test.ts —— [D3-④ 预检 capabilities 化] 拦截矩阵单测。
// 设计权威源：docs/design/subagent-dual-track-convergence.md §3.3 D3-④（r3 裁定：
// EngineCapabilities +maxTurns 位 pi=true/zcode=false，不保留硬编码 shape 检查）+
// §3.4 错误规格第 1 行 + §4 V4④⑤（正反向验收）。
//
// 覆盖（构建者白盒 + 使用者黑盒）：
//   1. per-engine 拦截矩阵：pi 全放行（含 maxTurns/fork/conversation/worktree——V4⑤
//      反向守护，pi 既有合法能力零拦截）；zcode 四参数全拦（fork/conversation/
//      maxTurns/worktree）
//   2. 错误族：engine_capability_unsupported + recovery 含可操作指引（换参数/换引擎）
//   3. fork 判据（借位裁定）：session 分叉通道族任一可用即放行——pi conversation=
//      native 放行（steer 虽 unsupported 不参与否决）；通道族全缺才拦

import { describe, expect, it } from "vitest";

import { assertTaskShapeSupported, type TaskShapeForGate } from "../../common/capability-gate.ts";
import { EngineError } from "../../common/errors.ts";
import type { EngineCapabilities } from "../../types.ts";
import { PiEngine } from "../../engines/pi/pi-engine.ts";
import { ZcodeEngine } from "../../engines/zcode/zcode-engine.ts";

/** 真实引擎的 capabilities 面单测直取（D3 声明是判据本体——pi=true/zcode=false 扩位）。 */
const PI_CAPS = new PiEngine({ getService: () => null }).capabilities();
const ZCODE_CAPS = new ZcodeEngine({ engineDataDir: () => "/tmp/zcode-gate" }).capabilities();

/** 会话分叉通道族可用的 zcode 形态变体（fork 判据用）。 */
const ZCODE_CAPS_WITH_CONVERSATION: EngineCapabilities = { ...ZCODE_CAPS, conversation: "native" };

function gate(
  caps: EngineCapabilities,
  task: TaskShapeForGate,
  engineId = "zcode",
): void {
  assertTaskShapeSupported(engineId, caps, task);
}

function gateError(caps: EngineCapabilities, task: TaskShapeForGate, engineId = "zcode"): EngineError {
  try {
    gate(caps, task, engineId);
  } catch (err) {
    expect(err).toBeInstanceOf(EngineError);
    return err as EngineError;
  }
  throw new Error("expected assertTaskShapeSupported to throw");
}

describe("capability-gate（D3-④ 拦截矩阵）", () => {
  it("能力位声明：pi maxTurns=true、zcode maxTurns=false（r3 扩位裁定）", () => {
    expect(PI_CAPS.maxTurns).toBe(true);
    expect(ZCODE_CAPS.maxTurns).toBe(false);
  });

  it("[V4⑤ 反向] pi 引擎全参数放行：maxTurns/fork/forkFromSessionFile/conversation/worktree 零拦截", () => {
    expect(() =>
      gate(PI_CAPS, { maxTurns: 3, fork: true, conversation: true, worktree: true }, "pi"),
    ).not.toThrow();
    expect(() => gate(PI_CAPS, { forkFromSessionFile: "/tmp/sess.jsonl", worktree: { path: "/tmp/wt" } }, "pi")).not.toThrow();
  });

  it("[V4④ 正向] zcode 引擎四参数全拦：fork/conversation/maxTurns/worktree → engine_capability_unsupported", () => {
    const cases: Array<[TaskShapeForGate, RegExp]> = [
      [{ fork: true }, /不支持 fork/],
      [{ forkFromSessionFile: "/tmp/sess.jsonl" }, /fork-from 同为父 session 上下文继承/],
      [{ conversation: true }, /不支持 conversation/],
      [{ maxTurns: 10 }, /不支持 maxTurns/],
      [{ worktree: true }, /不支持 worktree 隔离/],
      [{ worktree: { path: "/tmp/wt" } }, /不支持 worktree 隔离/],
    ];
    for (const [task, pattern] of cases) {
      const err = gateError(ZCODE_CAPS, task);
      expect(err.code).toBe("engine_capability_unsupported");
      expect(err.message).toMatch(pattern);
      expect(err.message).toContain("capabilities");
      // 错误信息可操作（§3.4）：恢复指引指向换参数/换引擎
      expect(err.recovery).toMatch(/engine: pi|不传|去掉/);
    }
  });

  it("zcode 放行面：无能力参数的任务全放行；maxTurns undefined（未传）不拦", () => {
    expect(() => gate(ZCODE_CAPS, {})).not.toThrow();
    expect(() => gate(ZCODE_CAPS, { maxTurns: undefined, fork: false, conversation: false, worktree: false })).not.toThrow();
  });

  it("fork 判据（借位裁定）：session 分叉通道族任一可用即放行——conversation=native 的引擎 fork 放行", () => {
    // pi 的 steer 声明 unsupported（spawn 链路未接通），fork 仍放行——通道族判定不因
    // 单一通道缺失而误拦（上面 pi 用例已覆盖）。此处补 zcode 形态 + conversation 通道
    // 可用的对照：fork 从拦截翻为放行。
    expect(() => gate(ZCODE_CAPS_WITH_CONVERSATION, { fork: true })).not.toThrow();
    expect(() => gate({ ...ZCODE_CAPS, steer: "native" }, { fork: true })).not.toThrow();
  });
});
