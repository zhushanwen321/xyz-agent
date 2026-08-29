// closed 终态展示语义派生护栏（U3 C-outcome 改锚版）。
//
// [历史] v4 B-1 时代，closed 终态的展示语义派生在三处手写同构（跨包依赖方向不允许互
// 相 import 源码，只能复制判定逻辑）：
//   1. packages/shared/src/subagent.ts —— deriveClosedDisplay（renderer 消费）
//   2. extensions/.../interface/bg-notify-render.ts —— renderRecordLines
//   3. extensions/.../execution/notifier.ts —— buildLlmContent
// 同构 switch 是维护事故温床（notifier 的 patchFile 分支曾遮蔽 gc+error 判定，失败终
// 态被 LLM 告知 completed——M1 修复存档）。
//
// [U3 现状] 三处同构 switch 收敛删除，扩展域内判定收敛为 execution-record.ts 的单一
// 权威实现：
//   - deriveOutcome(closedReason, error)：cancelled 优先 → error 非空（truthy）→ completed
//   - projectOutcome(...)：投影唯一出口（一等 outcome 直读优先，存量/重建 record 兜底）
// 消费方（completeRecord 唯一写入点 / notifier.buildLlmContent / bg-notify-render.
// renderRecordLines / subagent-actions.recordToListItem）只读 outcome 或调用单一函数，
// 不再各自手写成败推导。
//
// 本护栏两件事：
//   1. 行为锚定：deriveOutcome / projectOutcome 判定顺序与显式取舍（含 D6 parent-shutdown
//      → failed，勿当 bug 改回 cancelled）。
//   2. 残留守卫：notifier / bg-notify-render 源码中不得再出现 closedReason 同构成败推导
//      的手写 switch 特征（?? "gc" 兜底、=== "gc" / === "cancelled" 字面量比较）。
//
// packages/shared/src/subagent.ts deriveClosedDisplay（GUI 侧）不在扩展域内，仍消费
// closedReason——GUI pane 消费 outcome 的 UI 升级属实施计划非目标，其同构性不再由本
// 护栏维护（GUI 切 outcome 时另行处理）。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveOutcome, projectOutcome } from "../execution/execution-record.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** 同构成败推导已收敛删除的两处消费方源码。 */
const CONSUMER_SOURCES = {
  notifier: join(here, "..", "execution", "notifier.ts"),
  render: join(here, "..", "interface", "bg-notify-render.ts"),
} as const;

/**
 * 手写同构 switch 的源码特征 token：出现即说明有人把收敛删除的成败推导又写了回去。
 * （"gc" 是 ClosedReason 专属字面量——outcome 三态不含它，消费方合法代码不会出现
 * `?? "gc"` / `=== "gc"`；cancelled 比较不列入——outcome === "cancelled" 是合法消费。）
 */
const LEGACY_DERIVATION_TOKENS = [/\?\?\s*["']gc["']/, /===\s*["']gc["']/] as const;

describe("deriveOutcome — 单一权威终态派生（行为锚定）", () => {
  it("completed：closed + 无 error（gc / user-close 正常完成）", () => {
    expect(deriveOutcome("gc", undefined)).toBe("completed");
    expect(deriveOutcome("user-close", undefined)).toBe("completed");
  });

  it("failed：closed + error 非空（gc 失败）", () => {
    expect(deriveOutcome("gc", "spawn EPIPE")).toBe("failed");
  });

  it("[D6 显式取舍] parent-shutdown/parent-fork/parent-new 合成关闭 → failed（勿改 cancelled）", () => {
    // disposeAllRecords 合成 result 恒写 error:"closed due to ${reason}"——
    // 「父进程关闭时子 agent 未完成即失败」为选定行为而非疏漏。
    expect(deriveOutcome("parent-shutdown", "closed due to parent-shutdown")).toBe("failed");
    expect(deriveOutcome("parent-fork", "closed due to parent-fork")).toBe("failed");
    expect(deriveOutcome("parent-new", "closed due to parent-new")).toBe("failed");
  });

  it("cancelled：取消优先于 error（abort 合成 result 可能带 error）", () => {
    expect(deriveOutcome("cancelled", undefined)).toBe("cancelled");
    expect(deriveOutcome("cancelled", "aborted by user")).toBe("cancelled");
  });

  it("空串 error 不构成 failed（与旧同构 `record.error &&` truthy 判定逐字对齐）", () => {
    expect(deriveOutcome("gc", "")).toBe("completed");
  });
});

describe("projectOutcome — 投影唯一出口（行为锚定）", () => {
  it("running → undefined；closed 一等 outcome 直读；存量 record 兜底派生", () => {
    expect(projectOutcome({ status: "running" })).toBeUndefined();
    expect(projectOutcome({ status: "closed", outcome: "failed" })).toBe("failed");
    expect(projectOutcome({ status: "closed", closedReason: "gc", error: "boom" })).toBe("failed");
    expect(projectOutcome({ status: "closed" })).toBe("completed");
  });
});

describe("同构 switch 残留守卫（收敛删除后不得写回）", () => {
  it("两处消费方源码可读（fail-loud 前置）", () => {
    for (const [key, p] of Object.entries(CONSUMER_SOURCES)) {
      expect(() => readFileSync(p, "utf-8"), `源文件不可读：${key} ${p}`).not.toThrow();
    }
  });

  it("notifier buildLlmContent / bg-notify-render renderRecordLines 无 closedReason 成败推导特征", () => {
    for (const [key, p] of Object.entries(CONSUMER_SOURCES)) {
      const src = readFileSync(p, "utf-8");
      for (const token of LEGACY_DERIVATION_TOKENS) {
        expect(
          token.test(src),
          `[${key}] 检出旧同构推导特征 /${token.source}/——成败判定应只读 outcome 或调用 ` +
            `execution-record.ts 的 deriveOutcome/projectOutcome（单一权威），禁止手写 switch 写回。` +
            `若确属新增合法用法，请同步更新本护栏的特征提取。`,
        ).toBe(false);
      }
      // 消费方必须经由单一权威实现
      expect(
        src.includes("deriveOutcome"),
        `[${key}] 未引用 deriveOutcome——outcome 兜底派生必须复用单一权威函数。`,
      ).toBe(true);
    }
  });
});
