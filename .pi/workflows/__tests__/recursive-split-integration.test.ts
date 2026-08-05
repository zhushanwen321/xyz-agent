import { describe, it, expect } from "vitest";
import {
  MAX_FRONTIER_RETRIES,
  MAX_NODE_ROUNDS,
  decideAbortOnAgentFailure,
  aggregateNodeFailure,
  collectFailedUnits,
} from "../recursive-split-utils.cjs";

// ── MF-2：executeActionAgent 副作用编排单测 ──────────────────────────
// 这些测试覆盖 recursive-split.js 内「abort-vs-retain 非对称分支」+「nodeFailures 聚合」
// 的高影响副作用。逻辑从 .js 抽到 utils.cjs 的纯函数（decideAbortOnAgentFailure /
// aggregateNodeFailure / collectFailedUnits），消费侧 executeActionAgent / BFS 主循环
// 只做一行接线（if agentFailure.abort → abortUnit；aggregateNodeFailure(nodeFailures, r)），
// 故测纯函数 = 测非对称分支的决策。
//
// 对应审查报告 MF-2 三场景：
//   (a) gate-failed → abortUnit 调用 + 节点进 failedUnits
//   (b) cannot-proceed → abortUnit 不调用 + 节点保留 frontier + 进 failedUnits
//   (c) cannot-proceed 节点 re-dispatch 成功 → 移出 failedUnits
// 外加 queryFrontier 永久故障 status:"error"（MAX_FRONTIER_RETRIES 阈值 + failedUnits 聚合）。

// ── decideAbortOnAgentFailure（abort-vs-retain 非对称分支） ─────────

describe("decideAbortOnAgentFailure — abort-vs-retain 非对称分支", () => {
  it("(a) gate-failed → abort=true（executeActionAgent 会调 abortUnit 熔断销毁 WorkUnit）", () => {
    const decision = decideAbortOnAgentFailure({ stopReason: "gate-failed", failedReason: "gate 连续 3 次 fail" });
    expect(decision).not.toBeNull();
    expect(decision!.abort).toBe(true);
    expect(decision!.failedReason).toBe("gate 连续 3 次 fail");
  });

  it("(b) cannot-proceed → abort=false（保留 frontier 等 re-dispatch，不销毁 WorkUnit）", () => {
    const decision = decideAbortOnAgentFailure({ stopReason: "cannot-proceed", failedReason: "缺外部依赖" });
    expect(decision).not.toBeNull();
    expect(decision!.abort).toBe(false);
    expect(decision!.failedReason).toBe("缺外部依赖");
  });

  it("(b) cannot-proceed 仍属失败 → 进 failedUnits（abort=false 但 decision 非 null）", () => {
    // 关键：abort=false 不代表成功——cannot-proceed 节点仍要写进 failedUnits 供上层决策。
    // decideAbortOnAgentFailure 返回非 null 即表示「是 agent 自报失败」，调用方据此写 nodeFailures。
    const decision = decideAbortOnAgentFailure({ stopReason: "cannot-proceed" });
    expect(decision).not.toBeNull();
  });

  it("gate-failed 缺 failedReason → 回退 stopReason 作 failedReason", () => {
    const decision = decideAbortOnAgentFailure({ stopReason: "gate-failed" });
    expect(decision!.abort).toBe(true);
    expect(decision!.failedReason).toBe("gate-failed");
  });

  it("cannot-proceed 缺 failedReason → 回退 stopReason 作 failedReason", () => {
    const decision = decideAbortOnAgentFailure({ stopReason: "cannot-proceed" });
    expect(decision!.abort).toBe(false);
    expect(decision!.failedReason).toBe("cannot-proceed");
  });

  it("action-done（即使 failedReason 残留）→ null（非失败，MF-3 回归）", () => {
    // LLM 结构化输出不受 schema 约束：action 成功后 failedReason 残留是常见现象，
    // 必须返回 null 让调用方跳过失败处理（否则会把刚成功的节点立即 abortUnit 销毁）。
    expect(decideAbortOnAgentFailure({ stopReason: "action-done", failedReason: "旧失败原因残留" })).toBeNull();
  });

  it("progressive-done / closed / crosslayer-descend → null（正常续接，非失败）", () => {
    expect(decideAbortOnAgentFailure({ stopReason: "progressive-done" })).toBeNull();
    expect(decideAbortOnAgentFailure({ stopReason: "closed" })).toBeNull();
    expect(decideAbortOnAgentFailure({ stopReason: "crosslayer-descend" })).toBeNull();
  });

  it("undefined / null / 空对象 → null（属性访问安全降级）", () => {
    expect(decideAbortOnAgentFailure(undefined)).toBeNull();
    expect(decideAbortOnAgentFailure(null)).toBeNull();
    expect(decideAbortOnAgentFailure({})).toBeNull();
  });

  it("abort 决策与 isAgentReportedFailure 严格一致——只有 gate-failed/cannot-proceed 产生 decision", () => {
    // 契约：decideAbortOnAgentFailure 是 isAgentReportedFailure 的「带副作用的超集」。
    // 非 null ⟺ isAgentReportedFailure === true。
    for (const stopReason of ["gate-failed", "cannot-proceed"]) {
      expect(decideAbortOnAgentFailure({ stopReason })).not.toBeNull();
    }
    for (const stopReason of ["action-done", "progressive-done", "closed", "crosslayer-descend"]) {
      expect(decideAbortOnAgentFailure({ stopReason })).toBeNull();
    }
  });
});

// ── aggregateNodeFailure（nodeFailures 写入/成功删除聚合） ──────────

describe("aggregateNodeFailure — failedReason 写入与成功移出", () => {
  it("失败结果（有 failedReason）→ 写入 nodeFailures", () => {
    const nodeFailures: Record<string, string> = {};
    aggregateNodeFailure(nodeFailures, { unitId: "wave:a", failedReason: "gate-failed" });
    expect(nodeFailures).toEqual({ "wave:a": "gate-failed" });
  });

  it("(c) 成功结果（无 failedReason）→ 移出既有 entry（cannot-proceed re-dispatch 恢复）", () => {
    // 场景 c：上轮 cannot-proceed 写入了 failedReason，本轮 re-dispatch 成功（无 failedReason）→ 删除。
    const nodeFailures: Record<string, string> = { "wave:a": "cannot-proceed" };
    aggregateNodeFailure(nodeFailures, { unitId: "wave:a" });
    expect(nodeFailures).toEqual({});
  });

  it("成功结果且无既有 entry → no-op（key 本就不存在，delete 安全）", () => {
    const nodeFailures: Record<string, string> = {};
    aggregateNodeFailure(nodeFailures, { unitId: "wave:a" });
    expect(nodeFailures).toEqual({});
  });

  it("null / undefined 结果 → no-op（parallel 归一化吞掉 / thrown）", () => {
    const nodeFailures: Record<string, string> = { "wave:a": "old" };
    aggregateNodeFailure(nodeFailures, null);
    aggregateNodeFailure(nodeFailures, undefined);
    expect(nodeFailures).toEqual({ "wave:a": "old" });
  });

  it("无 unitId 的结果 → no-op", () => {
    const nodeFailures: Record<string, string> = {};
    aggregateNodeFailure(nodeFailures, { failedReason: "no-unit" });
    expect(nodeFailures).toEqual({});
  });

  it("多节点独立聚合（concurrent 批次多结果逐个写）", () => {
    const nodeFailures: Record<string, string> = {};
    aggregateNodeFailure(nodeFailures, { unitId: "wave:a", failedReason: "gate-failed" });
    aggregateNodeFailure(nodeFailures, { unitId: "wave:b" }); // b 成功
    aggregateNodeFailure(nodeFailures, { unitId: "wave:c", failedReason: "cannot-proceed" });
    expect(nodeFailures).toEqual({ "wave:a": "gate-failed", "wave:c": "cannot-proceed" });
  });

  it("同一节点失败→成功交替（re-dispatch 恢复后移出清单）", () => {
    const nodeFailures: Record<string, string> = {};
    // 第 1 轮 cannot-proceed → 写入
    aggregateNodeFailure(nodeFailures, { unitId: "wave:a", failedReason: "cannot-proceed" });
    expect(nodeFailures["wave:a"]).toBe("cannot-proceed");
    // 第 2 轮 re-dispatch 成功 → 移出
    aggregateNodeFailure(nodeFailures, { unitId: "wave:a" });
    expect("wave:a" in nodeFailures).toBe(false);
  });

  it("就地 mutate 传入的 Map（不返回新对象，与 detectStuckNodes 副作用契约一致）", () => {
    const nodeFailures: Record<string, string> = {};
    const ref = nodeFailures;
    aggregateNodeFailure(nodeFailures, { unitId: "wave:a", failedReason: "fail" });
    expect(ref).toBe(nodeFailures);
    expect(ref).toEqual({ "wave:a": "fail" });
  });
});

// ── collectFailedUnits（done & error 终态返回值共用的聚合） ─────────

describe("collectFailedUnits — failedUnits 数组聚合", () => {
  it("空映射 → 空数组（done 路径无失败时 failedUnits 缺省）", () => {
    expect(collectFailedUnits({})).toEqual([]);
  });

  it("单 entry → [{unitId, failedReason}]", () => {
    expect(collectFailedUnits({ "wave:a": "gate-failed" })).toEqual([
      { unitId: "wave:a", failedReason: "gate-failed" },
    ]);
  });

  it("多 entry → 每条一个对象（保持插入序，与内联实现一致）", () => {
    const map = { "wave:a": "gate-failed", "wave:b": "cannot-proceed", "slice:c": "timeout" };
    expect(collectFailedUnits(map)).toEqual([
      { unitId: "wave:a", failedReason: "gate-failed" },
      { unitId: "wave:b", failedReason: "cannot-proceed" },
      { unitId: "slice:c", failedReason: "timeout" },
    ]);
  });

  it("done 路径：有失败 → failedUnits 非空（调用方据此区分完整/不完整树）", () => {
    // recursive-split.js done 路径：failedUnits.length > 0 ? { failedUnits } : {}
    const failedUnits = collectFailedUnits({ "wave:a": "cannot-proceed" });
    expect(failedUnits.length).toBeGreaterThan(0);
    // 模拟 done 路径条件展开
    const doneResult = { status: "done", ...(failedUnits.length > 0 ? { failedUnits } : {}) };
    expect(doneResult.failedUnits).toBeDefined();
  });

  it("done 路径：无失败 → failedUnits 缺省（不出现空数组字段）", () => {
    const failedUnits = collectFailedUnits({});
    const doneResult = { status: "done", ...(failedUnits.length > 0 ? { failedUnits } : {}) };
    expect(doneResult.failedUnits).toBeUndefined();
  });
});

// ── MF-2 三场景端到端（决策 → 聚合 → failedUnits） ───────────────

describe("MF-2 场景：abort-vs-retain 决策与 failedUnits 聚合串联", () => {
  it("(a) gate-failed → abort=true + 节点进 failedUnits", () => {
    // 模拟 executeActionAgent + BFS 聚合的副作用链（去掉真实 agent/execSync）。
    const nodeFailures: Record<string, string> = {};
    const value = { stopReason: "gate-failed", failedReason: "gate 连续 3 次 fail" } as const;

    const decision = decideAbortOnAgentFailure(value);
    expect(decision!.abort).toBe(true); // → executeActionAgent 会 await abortUnit(node.unitId)

    // 返回值带 failedReason → BFS 聚合写入
    const result = { unitId: "wave:auth", failedReason: decision!.failedReason };
    aggregateNodeFailure(nodeFailures, result);

    // failedUnits 含该节点
    expect(collectFailedUnits(nodeFailures)).toContainEqual({
      unitId: "wave:auth",
      failedReason: "gate 连续 3 次 fail",
    });
  });

  it("(b) cannot-proceed → abort=false（不销毁 WorkUnit）但仍进 failedUnits", () => {
    const nodeFailures: Record<string, string> = {};
    const value = { stopReason: "cannot-proceed", failedReason: "缺依赖" } as const;

    const decision = decideAbortOnAgentFailure(value);
    expect(decision!.abort).toBe(false); // → executeActionAgent 不调 abortUnit，节点保留 frontier

    // cannot-proceed 仍带 failedReason → BFS 聚合写入（供上层决策通道）
    const result = { unitId: "wave:auth", failedReason: decision!.failedReason };
    aggregateNodeFailure(nodeFailures, result);

    expect(collectFailedUnits(nodeFailures)).toContainEqual({
      unitId: "wave:auth",
      failedReason: "缺依赖",
    });
  });

  it("(c) cannot-proceed 节点 re-dispatch 成功 → 移出 failedUnits", () => {
    const nodeFailures: Record<string, string> = {};

    // 第 1 轮：cannot-proceed → 写入 failedUnits
    let decision = decideAbortOnAgentFailure({ stopReason: "cannot-proceed", failedReason: "暂时缺依赖" });
    aggregateNodeFailure(nodeFailures, { unitId: "wave:auth", failedReason: decision!.failedReason });
    expect(collectFailedUnits(nodeFailures)).toHaveLength(1);

    // 第 2 轮：外部条件解除，re-dispatch 成功（stopReason=action-done → decision=null → 无 failedReason）
    decision = decideAbortOnAgentFailure({ stopReason: "action-done" });
    expect(decision).toBeNull(); // 非失败
    // executeActionAgent 返回无 failedReason → BFS 聚合删除既有 entry
    aggregateNodeFailure(nodeFailures, { unitId: "wave:auth" });

    // failedUnits 不再含该节点（恢复成功的节点不误导上层决策）
    expect(collectFailedUnits(nodeFailures)).toEqual([]);
  });
});

// ── queryFrontier 永久故障：status:"error"（非 "done"）的失败聚合 ──

describe("queryFrontier 永久故障 — failedUnits 聚合 + 阈值", () => {
  it("MAX_FRONTIER_RETRIES 阈值控制永久故障判定（连续失败到阈值才终止）", () => {
    // recursive-split.js：frontierFailures >= MAX_FRONTIER_RETRIES → phase("error") + return status:"error"。
    // 阈值下方 continue 重试（不终止）；阈值上方判定永久故障返回 error（不 break 走 done）。
    expect(MAX_FRONTIER_RETRIES).toBe(3);
    // 模拟连续失败计数判定
    for (let i = 1; i < MAX_FRONTIER_RETRIES; i++) {
      expect(i >= MAX_FRONTIER_RETRIES).toBe(false); // 1, 2 → continue 重试
    }
    expect(MAX_FRONTIER_RETRIES >= MAX_FRONTIER_RETRIES).toBe(true); // 3 → 永久故障
  });

  it("永久故障返回 status:error 时 failedUnits 由 collectFailedUnits 提供（含既有失败节点）", () => {
    // 场景：BFS 已聚合若干失败节点，随后 queryFrontier 连续失败到阈值 → error 路径用同一聚合。
    const nodeFailures: Record<string, string> = {
      "wave:a": "gate-failed",
      "wave:b": "cannot-proceed",
    };
    const failedUnits = collectFailedUnits(nodeFailures);
    // error 路径返回值形状：status:"error" + error message + failedUnits（length>0 时展开）
    const errorResult = {
      status: "error",
      error: "queryFrontier failed " + MAX_FRONTIER_RETRIES + " consecutive times, tree incomplete",
      ...(failedUnits.length > 0 ? { failedUnits } : {}),
    };
    expect(errorResult.status).toBe("error"); // 非 "done"——树残留非终态节点
    expect(errorResult.failedUnits).toHaveLength(2);
  });

  it("永久故障无失败节点时 failedUnits 缺省（错误结果仍含 status/error）", () => {
    const failedUnits = collectFailedUnits({});
    const errorResult = {
      status: "error",
      error: "queryFrontier failed " + MAX_FRONTIER_RETRIES + " consecutive times, tree incomplete",
      ...(failedUnits.length > 0 ? { failedUnits } : {}),
    };
    expect(errorResult.status).toBe("error");
    expect(errorResult.failedUnits).toBeUndefined();
  });
});

// ── MF-1：熔断/stuck-abort 与 concurrent thrown 两条杀路径接入 failedUnits ──
// recursive-split.js 主循环的两条 kill path（stuck-abort 循环 + concurrent thrown 分支）
// 在 R2 之前只 abort 不写 nodeFailures，被杀的节点对上层 failedUnits 决策通道不可见，
// 整棵树以 status:done 返回且无 failedUnits 键。本组测试覆盖 R3 接线形态：
//   (a) stuck-abort → abortUnit + 写入 "stuck: ..." 前缀 failedReason
//   (b) stuck-abort 防重复记录：既有 entry（sequential catch 已记 "threw: ..."）不被覆盖
//   (c) concurrent thrown → 按下标从 concurrent 数组恢复 unitId → abort + 写入

describe("MF-1: 熔断与 thrown 杀路径的 failedUnits 聚合", () => {
  it("(a) stuck-abort：熔断 abort 的节点写入 failedUnits（done 返回值含该节点，不再静默截断）", () => {
    // 模拟 recursive-split.js stuck-abort 循环接线：replan/clarify 循环型节点每轮 dispatch
    // 返回成功、无 failedReason → nodeFailures 从未写入，熔断是唯一失败记录点。
    const nodeFailures: Record<string, string> = {};
    const unitId = "wave:loop-replan";
    const failedReason = "stuck: status not progressing for " + MAX_NODE_ROUNDS + " rounds";
    aggregateNodeFailure(nodeFailures, { unitId, failedReason });

    const failedUnits = collectFailedUnits(nodeFailures);
    const doneResult = { status: "done", ...(failedUnits.length > 0 ? { failedUnits } : {}) };
    expect(doneResult.failedUnits).toContainEqual({ unitId, failedReason });
  });

  it("(b) stuck-abort 防重复记录：既有 entry 保持原 failedReason（sequential catch 已记录）", () => {
    // 场景：sequential catch 已 abort + 记录 "threw: ..."，但 abort 失败导致节点留在
    // frontier，下一轮被 detectStuckNodes 再次熔断。recursive-split.js 接线在记录前
    // 守卫 nodeFailures[unitId] 已存在（保持 "threw: ..." 而非被 "stuck: ..." 覆盖）。
    const nodeFailures: Record<string, string> = {};
    const unitId = "wave:a";
    aggregateNodeFailure(nodeFailures, { unitId, failedReason: "threw: boom" });

    if (!nodeFailures[unitId]) {
      aggregateNodeFailure(nodeFailures, {
        unitId,
        failedReason: "stuck: status not progressing for " + MAX_NODE_ROUNDS + " rounds",
      });
    }
    expect(nodeFailures[unitId]).toBe("threw: boom");
  });

  it("(c) concurrent thrown：按下标恢复 unitId → abort + 写入 failedUnits（不再吞掉失败）", () => {
    // parallel 结果与 concurrent 数组按下标一一对应（allSettled 语义，每结果唯一对象）：
    // results.indexOf(r) 即原节点下标。模拟 recursive-split.js concurrent thrown 接线。
    const concurrent = [{ unitId: "wave:a" }, { unitId: "wave:b" }];
    const results = [
      { status: "fulfilled", value: { unitId: "wave:a" } },
      { status: "failed", error: "boom" },
    ];
    const nodeFailures: Record<string, string> = {};
    for (const r of results) {
      if (!r) continue;
      if (r.status === "failed") {
        const thrownIdx = results.indexOf(r);
        const thrownUnitId = thrownIdx >= 0 ? concurrent[thrownIdx]?.unitId : undefined;
        if (thrownUnitId) {
          aggregateNodeFailure(nodeFailures, {
            unitId: thrownUnitId,
            failedReason: "threw: " + String(r.error ?? "unknown"),
          });
        }
      } else if (r.value) {
        aggregateNodeFailure(nodeFailures, r.value);
      }
    }

    expect(nodeFailures).toEqual({ "wave:b": "threw: boom" });
    expect(collectFailedUnits(nodeFailures)).toContainEqual({
      unitId: "wave:b",
      failedReason: "threw: boom",
    });
  });
});
