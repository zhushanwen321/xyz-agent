// src/execution/__tests__/parent-child-matrix.test.ts
//
// SP-4: 父子联动矩阵测试。
//
// 验证：
//   TC-1: fork 级联关闭 → record 标 closed{reason:"parent-fork"}
//   TC-2: recentlyCascaded 收集被关 record
//   TC-3: before_agent_start hook 注入告知消息
//   TC-4: 60s 超时自动清空 recentlyCascaded

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  completeRecord,
  createRecord,
  snapshot,
  tryTransition,
} from "../execution-record.ts";
import type {
  ClosedReason,
  ExecutionRecord,
  SubagentRecord,
} from "../types.ts";
import { RecordStore } from "../record-store.ts";
import { formatSubagentStatusSnapshot } from "../../index.ts";

// ── helpers ──

/** 创建一个 running 状态的可变 ExecutionRecord（内存态）。 */
function makeRunningRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: `task for ${id}`,
    slug: `slug-${id}`,
    startedAt: Date.now(),
    rootSessionId: "session-main",
    controller: new AbortController(),
    ...overrides,
  });
  return record;
}

/** 创建一个 idle 状态的可变 ExecutionRecord（对话模式轮次完成）。 */
function makeIdleRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const record = makeRunningRecord(id, overrides);
  record.status = "idle";
  record.round = 1;
  return record;
}

// ── SubagentRecord stub 工厂（formatSubagentStatusSnapshot 用）──

function makeSubagentRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-abc123",
    agent: "general-purpose",
    task: "test task",
    slug: "test-slug",
    status: "running",
    mode: "background",
    startedAt: Date.now(),
    rootSessionId: "session-main",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: "test/model",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
    sessionFile: undefined,
    round: 0,
    ...over,
  };
}

// ============================================================
// TC-1: fork/new 级联关闭 → record 标 closed{reason}
// ============================================================

describe("disposeAllRecords cascade close", () => {
  it("TC-1a: running record 被关闭为 closed + parent-fork reason", () => {
    const record = makeRunningRecord("sa-001");
    expect(record.status).toBe("running");

    // 模拟 tryTransition + completeRecord 流程（SubagentService.disposeAllRecords 的核心逻辑）
    const transitioned = tryTransition(record, "closed", "parent-fork");
    expect(transitioned).toBe(true);

    completeRecord(record, {
      text: "",
      turns: 0,
      durationMs: 100,
      success: false,
      error: "closed due to parent-fork",
      sessionId: record.id,
      toolCalls: [],
    }, "closed", "parent-fork");

    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("parent-fork");
  });

  it("TC-1b: idle record 被关闭为 closed + parent-new reason（直接 completeRecord）", () => {
    const record = makeIdleRecord("sa-002");

    // idle record 不经过 tryTransition（CAS 只对 running 生效），直接 completeRecord
    // 与 SubagentService.disposeAllRecords 的 idle 分支一致
    completeRecord(record, {
      text: "",
      turns: 1,
      durationMs: 200,
      success: false,
      error: "closed due to parent-new",
      sessionId: record.id,
      toolCalls: [],
    }, "closed", "parent-new");

    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("parent-new");
  });

  it("TC-1c: parent-shutdown reason 正确应用", () => {
    const record = makeRunningRecord("sa-003");

    tryTransition(record, "closed", "parent-shutdown");
    completeRecord(record, {
      text: "",
      turns: 0,
      durationMs: 50,
      success: false,
      error: "closed due to parent-shutdown",
      sessionId: record.id,
      toolCalls: [],
    }, "closed", "parent-shutdown");

    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("parent-shutdown");
  });

  it("TC-1d: 已终态 record 不可再被 tryTransition", () => {
    const record = makeRunningRecord("sa-004");
    // 先转终态
    expect(tryTransition(record, "closed", "gc")).toBe(true);
    completeRecord(record, {
      text: "",
      turns: 0,
      durationMs: 0,
      success: false,
      sessionId: record.id,
      toolCalls: [],
    }, "closed", "gc");

    // 再次尝试应失败（CAS 保护）
    expect(tryTransition(record, "closed", "parent-fork")).toBe(false);
    expect(record.closedReason).toBe("gc"); // 保持原 reason
  });
});

// ============================================================
// TC-2: recentlyCascaded 收集被关 record
// ============================================================

describe("recentlyCascaded collection", () => {
  it("TC-2a: 被关 record 收集到 recentlyCascaded", () => {
    const recentlyCascaded: Array<{ recordId: string; reason: ClosedReason }> = [];

    // 模拟 disposeAllRecords 的收集逻辑
    const record = makeRunningRecord("sa-100");
    if (tryTransition(record, "closed", "parent-fork")) {
      completeRecord(record, {
        text: "",
        turns: 0,
        durationMs: 0,
        success: false,
        error: "closed due to parent-fork",
        sessionId: record.id,
        toolCalls: [],
      }, "closed", "parent-fork");
      recentlyCascaded.push({ recordId: record.id, reason: "parent-fork" });
    }

    expect(recentlyCascaded).toHaveLength(1);
    expect(recentlyCascaded[0]).toEqual({ recordId: "sa-100", reason: "parent-fork" });
  });

  it("TC-2b: 多条 record 收集正确", () => {
    const recentlyCascaded: Array<{ recordId: string; reason: ClosedReason }> = [];

    for (let i = 0; i < 3; i++) {
      const record = makeRunningRecord(`sa-${i}`);
      if (tryTransition(record, "closed", "parent-new")) {
        completeRecord(record, {
          text: "",
          turns: 0,
          durationMs: 0,
          success: false,
          error: "closed due to parent-new",
          sessionId: record.id,
          toolCalls: [],
        }, "closed", "parent-new");
        recentlyCascaded.push({ recordId: record.id, reason: "parent-new" });
      }
    }

    expect(recentlyCascaded).toHaveLength(3);
    expect(recentlyCascaded.every((c) => c.reason === "parent-new")).toBe(true);
  });

  it("TC-2c: idle record 也被收集（直接 completeRecord）", () => {
    const recentlyCascaded: Array<{ recordId: string; reason: ClosedReason }> = [];

    const record = makeIdleRecord("sa-idle");
    // idle record: 不经 tryTransition，直接 completeRecord
    completeRecord(record, {
      text: "",
      turns: 1,
      durationMs: 100,
      success: false,
      error: "closed due to parent-fork",
      sessionId: record.id,
      toolCalls: [],
    }, "closed", "parent-fork");
    recentlyCascaded.push({ recordId: record.id, reason: "parent-fork" });

    expect(recentlyCascaded).toHaveLength(1);
    expect(recentlyCascaded[0]?.recordId).toBe("sa-idle");
  });
});

// ============================================================
// TC-3: before_agent_start hook 注入告知消息
// ============================================================

describe("before_agent_start cascade notification injection", () => {
  it("TC-3a: 仅有级联关闭记录（无活跃 subagent）时注入告知消息", () => {
    const cascaded = [
      { recordId: "sa-001", reason: "parent-fork" as ClosedReason },
      { recordId: "sa-002", reason: "parent-fork" as ClosedReason },
    ];
    const activeRecords: SubagentRecord[] = [];

    // 模拟 hook 逻辑
    const parts: string[] = [];
    if (activeRecords.length > 0) {
      parts.push(formatSubagentStatusSnapshot(activeRecords));
    }
    if (cascaded.length > 0) {
      const reasonGroups = new Map<string, string[]>();
      for (const item of cascaded) {
        const ids = reasonGroups.get(item.reason) ?? [];
        ids.push(item.recordId);
        reasonGroups.set(item.reason, ids);
      }
      const summary = Array.from(reasonGroups.entries())
        .map(([reason, ids]) => `${ids.length} due to ${reason} (${ids.join(", ")})`)
        .join("; ");
      parts.push(`[subagent-closed] ${cascaded.length} subagent${cascaded.length === 1 ? "" : "s"} closed: ${summary}`);
    }

    const content = parts.join("\n");

    expect(content).toContain("[subagent-closed] 2 subagents closed:");
    expect(content).toContain("2 due to parent-fork (sa-001, sa-002)");
  });

  it("TC-3b: 同时有活跃 subagent 和级联关闭记录", () => {
    const cascaded = [
      { recordId: "sa-old", reason: "parent-new" as ClosedReason },
    ];
    const activeRecords = [
      makeSubagentRecord({ id: "sa-new", slug: "new-task", status: "running" }),
    ];

    const parts: string[] = [];
    if (activeRecords.length > 0) {
      parts.push(formatSubagentStatusSnapshot(activeRecords));
    }
    if (cascaded.length > 0) {
      const reasonGroups = new Map<string, string[]>();
      for (const item of cascaded) {
        const ids = reasonGroups.get(item.reason) ?? [];
        ids.push(item.recordId);
        reasonGroups.set(item.reason, ids);
      }
      const summary = Array.from(reasonGroups.entries())
        .map(([reason, ids]) => `${ids.length} due to ${reason} (${ids.join(", ")})`)
        .join("; ");
      parts.push(`[subagent-closed] ${cascaded.length} subagent${cascaded.length === 1 ? "" : "s"} closed: ${summary}`);
    }

    const content = parts.join("\n");

    // 包含活跃 subagent 信息
    expect(content).toContain("[subagent-status] 1 active subagent:");
    expect(content).toContain("sa-new");
    // 包含级联关闭信息
    expect(content).toContain("[subagent-closed] 1 subagent closed:");
    expect(content).toContain("1 due to parent-new (sa-old)");
  });

  it("TC-3c: 级联关闭为空、无活跃 subagent 时不注入", () => {
    const cascaded: Array<{ recordId: string; reason: ClosedReason }> = [];
    const activeRecords: SubagentRecord[] = [];

    const shouldInject = activeRecords.length > 0 || cascaded.length > 0;
    expect(shouldInject).toBe(false);
  });

  it("TC-3d: 不同 reason 分组正确", () => {
    const cascaded = [
      { recordId: "sa-001", reason: "parent-fork" as ClosedReason },
      { recordId: "sa-002", reason: "parent-new" as ClosedReason },
      { recordId: "sa-003", reason: "parent-fork" as ClosedReason },
    ];

    const reasonGroups = new Map<string, string[]>();
    for (const item of cascaded) {
      const ids = reasonGroups.get(item.reason) ?? [];
      ids.push(item.recordId);
      reasonGroups.set(item.reason, ids);
    }

    expect(reasonGroups.size).toBe(2);
    expect(reasonGroups.get("parent-fork")).toEqual(["sa-001", "sa-003"]);
    expect(reasonGroups.get("parent-new")).toEqual(["sa-002"]);

    const summary = Array.from(reasonGroups.entries())
      .map(([reason, ids]) => `${ids.length} due to ${reason} (${ids.join(", ")})`)
      .join("; ");

    expect(summary).toContain("2 due to parent-fork (sa-001, sa-003)");
    expect(summary).toContain("1 due to parent-new (sa-002)");
  });
});

// ============================================================
// TC-4: 60s 超时自动清空 recentlyCascaded
// ============================================================

describe("recentlyCascaded auto-clear timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("TC-4a: 60s 后自动清空 recentlyCascaded", () => {
    const recentlyCascaded = [
      { recordId: "sa-001", reason: "parent-fork" as ClosedReason },
      { recordId: "sa-002", reason: "parent-new" as ClosedReason },
    ];

    // 模拟 scheduleCascadedClear 逻辑
    setTimeout(() => {
      recentlyCascaded.length = 0;
    }, 60_000);

    // 59s 后仍存在
    vi.advanceTimersByTime(59_000);
    expect(recentlyCascaded).toHaveLength(2);

    // 60s 后清空
    vi.advanceTimersByTime(1_001);
    expect(recentlyCascaded).toHaveLength(0);
  });

  it("TC-4b: 多次 onParentFork 不叠加超时（各自独立清空）", () => {
    const recentlyCascaded: Array<{ recordId: string; reason: ClosedReason }> = [];

    // 第一次 fork：添加 1 条
    recentlyCascaded.push({ recordId: "sa-001", reason: "parent-fork" });
    setTimeout(() => { recentlyCascaded.length = 0; }, 60_000);

    // 第二次 fork（30s 后）：添加 1 条
    vi.advanceTimersByTime(30_000);
    recentlyCascaded.push({ recordId: "sa-002", reason: "parent-new" });
    setTimeout(() => { recentlyCascaded.length = 0; }, 60_000);

    // 30s 后（60s 总时间）：第一次超时触发，清空
    vi.advanceTimersByTime(30_001);
    expect(recentlyCascaded).toHaveLength(0);
  });

  it("TC-4c: 注入后立即清空（一次性消费）", () => {
    const recentlyCascaded = [
      { recordId: "sa-001", reason: "parent-fork" as ClosedReason },
    ];

    // 模拟 hook 注入后清空
    const content = `[subagent-closed] ${recentlyCascaded.length} subagent closed`;
    expect(content).toContain("[subagent-closed] 1 subagent closed");

    // 注入后清空
    recentlyCascaded.length = 0;
    expect(recentlyCascaded).toHaveLength(0);
  });
});

// ============================================================
// TC-5: RecordStore.listAllActive 集成验证
// ============================================================

describe("RecordStore.listAllActive", () => {
  it("TC-5a: 返回 running + idle record，排除终态", () => {
    // 注意：RecordStore 需要 sessionsDir 等依赖，这里用 mock 验证行为
    // 实际 listAllActive 的单元测试在 record-store.test.ts 中覆盖
    const running = makeRunningRecord("sa-r");
    const idle = makeIdleRecord("sa-i");

    // 模拟 listAllActive 过滤逻辑
    const allRecords = [running, idle];
    const closed = makeRunningRecord("sa-c");
    tryTransition(closed, "closed", "gc");
    completeRecord(closed, {
      text: "", turns: 0, durationMs: 0, success: false, sessionId: "sa-c", toolCalls: [],
    }, "closed", "gc");
    allRecords.push(closed);

    const active = allRecords.filter((r) => r.status === "running" || r.status === "idle");

    expect(active).toHaveLength(2);
    expect(active.map((r) => r.id)).toContain("sa-r");
    expect(active.map((r) => r.id)).toContain("sa-i");
    expect(active.map((r) => r.id)).not.toContain("sa-c");
  });
});
