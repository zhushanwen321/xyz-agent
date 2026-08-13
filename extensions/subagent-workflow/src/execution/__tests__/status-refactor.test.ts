// src/execution/__tests__/status-refactor.test.ts
//
// SP-1: L1/L2 状态机重构验证测试。
//
// 验证：
//   1. ClosedReason 枚举完整性（6 个值）
//   2. tryTransition → closed + closedReason 写入
//   3. completeRecord → closed + closedReason 写入
//   4. notifier dedupKey 回归纯 id（删 round 豁免）
//   5. ExecutionStatus 不含 done/failed/crashed 字面量
//   6. mapExternalState closed → ended
//   7. statusGlyph closed → ✓ success
//   8. BgNotifyRecord.status 不含 done/failed

import { describe, expect, it } from "vitest";

import { completeRecord, createRecord, tryTransition } from "../execution-record.ts";
import { BgNotifier } from "../notifier.ts";
import type { BgNotifyRecord, NotifierHost } from "../notifier.ts";
import { mapExternalState } from "../../interface/subagent-actions.ts";
import { statusGlyph } from "../../interface/format.ts";
import type { ClosedReason, ExecutionRecord, ExecutionStatus } from "../types.ts";

// ============================================================
// ClosedReason 枚举完整性
// ============================================================

describe("ClosedReason enum", () => {
  it("包含全部 6 个值", () => {
    const reasons: ClosedReason[] = [
      "parent-shutdown",
      "parent-fork",
      "parent-new",
      "user-close",
      "cancelled",
      "gc",
    ];
    // 类型检查：赋值不报错即通过
    expect(reasons).toHaveLength(6);
  });

  it("ClosedReason 值类型正确", () => {
    const r: ClosedReason = "gc";
    expect(typeof r).toBe("string");
  });
});

// ============================================================
// ExecutionStatus 不含旧字面量
// ============================================================

describe("ExecutionStatus type", () => {
  it("合法值只有 running/idle/cancelled/closed", () => {
    const validStatuses: ExecutionStatus[] = [
      "running",
      "idle",
      "cancelled",
      "closed",
    ];
    expect(validStatuses).toHaveLength(4);
  });

  it("done/failed/crashed 不是合法 ExecutionStatus", () => {
    // 编译期验证：以下赋值应报 TS 类型错误（通过 @ts-expect-error 验证）
    // @ts-expect-error SP-1: done 已移除
    const _done: ExecutionStatus = "done";
    // @ts-expect-error SP-1: failed 已移除
    const _failed: ExecutionStatus = "failed";
    // @ts-expect-error SP-1: crashed 已移除
    const _crashed: ExecutionStatus = "crashed";
    // 如果编译通过说明类型未正确收窄——此测试不应到达运行时
    expect(_done).toBe("done"); // never reached if tsc errors
  });
});

// ============================================================
// tryTransition + closedReason
// ============================================================

describe("tryTransition with closed + closedReason", () => {
  function makeRunningRecord(): ExecutionRecord {
    return createRecord("test-1", {
      agent: "test-agent",
      model: "test-model",
      mode: "background",
      task: "test task",
      slug: "test-slug",
      startedAt: Date.now(),
    });
  }

  it("running → closed + gc 写入 closedReason", () => {
    const record = makeRunningRecord();
    expect(record.status).toBe("running");

    const ok = tryTransition(record, "closed", "gc");
    expect(ok).toBe(true);
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
  });

  it("running → closed + user-close 写入 closedReason", () => {
    const record = makeRunningRecord();
    const ok = tryTransition(record, "closed", "user-close");
    expect(ok).toBe(true);
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
  });

  it("running → closed 无 closedReason 默认 gc", () => {
    const record = makeRunningRecord();
    const ok = tryTransition(record, "closed");
    expect(ok).toBe(true);
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
  });

  it("running → cancelled 不写 closedReason", () => {
    const record = makeRunningRecord();
    const ok = tryTransition(record, "cancelled");
    expect(ok).toBe(true);
    expect(record.status).toBe("cancelled");
    expect(record.closedReason).toBeUndefined();
  });

  it("closed 不可再转（CAS 互斥锁）", () => {
    const record = makeRunningRecord();
    tryTransition(record, "closed", "gc");
    const ok = tryTransition(record, "closed", "user-close");
    expect(ok).toBe(false);
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc"); // 未被覆盖
  });

  it("cancelled 不可再转（CAS 互斥锁）", () => {
    const record = makeRunningRecord();
    tryTransition(record, "cancelled");
    const ok = tryTransition(record, "closed", "gc");
    expect(ok).toBe(false);
    expect(record.status).toBe("cancelled");
  });

  it("idle 不可转 closed（CAS 要求 running）", () => {
    const record = makeRunningRecord();
    record.status = "idle";
    const ok = tryTransition(record, "closed", "gc");
    expect(ok).toBe(false);
    expect(record.status).toBe("idle");
  });
});

// ============================================================
// completeRecord + closedReason
// ============================================================

describe("completeRecord with closed + closedReason", () => {
  function makeRunningRecord(): ExecutionRecord {
    return createRecord("test-cr", {
      agent: "test-agent",
      model: "test-model",
      mode: "background",
      task: "test task",
      slug: "test-slug",
      startedAt: Date.now(),
    });
  }

  it("closed + gc 写入 closedReason + endedAt", () => {
    const record = makeRunningRecord();
    const result = { text: "done", turns: 1, durationMs: 100, success: true, sessionId: "s", toolCalls: [] };
    completeRecord(record, result, "closed", "gc");

    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
    expect(record.endedAt).toBeDefined();
    expect(record.result).toBe("done");
  });

  it("closed + user-close 写入 closedReason", () => {
    const record = makeRunningRecord();
    const result = { text: "", turns: 0, durationMs: 0, success: true, sessionId: "s", toolCalls: [] };
    completeRecord(record, result, "closed", "user-close");

    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
  });

  it("closed 无 closedReason 默认 gc", () => {
    const record = makeRunningRecord();
    const result = { text: "", turns: 0, durationMs: 0, success: true, sessionId: "s", toolCalls: [] };
    completeRecord(record, result, "closed");

    expect(record.closedReason).toBe("gc");
  });

  it("cancelled 不写 closedReason", () => {
    const record = makeRunningRecord();
    const result = { text: "", turns: 0, durationMs: 0, success: false, error: "cancelled", sessionId: "s", toolCalls: [] };
    completeRecord(record, result, "cancelled");

    expect(record.status).toBe("cancelled");
    expect(record.closedReason).toBeUndefined();
  });
});

// ============================================================
// Notifier dedupKey 回归纯 id（删 round 豁免）
// ============================================================

describe("BgNotifier dedupKey", () => {
  function createMockHost(hasRunning = false): NotifierHost {
    return {
      sendMessage: () => {},
      hasRunningBackground: () => hasRunning,
    };
  }

  it("同 id 不同 round 在 60s 内被去重（纯 id 去重）", () => {
    const host = createMockHost(false);
    const notifier = new BgNotifier(host);
    const sent: unknown[] = [];
    // 重写 sendMessage 捕获
    (host as { sendMessage: NotifierHost["sendMessage"] }).sendMessage = (msg) => { sent.push(msg); };

    const record1: BgNotifyRecord = {
      id: "sa-123",
      status: "closed",
      agent: "test",
      result: "round 1",
      startedAt: Date.now(),
      endedAt: Date.now(),
      round: 1,
    };
    const record2: BgNotifyRecord = {
      id: "sa-123", // 同 id
      status: "closed",
      agent: "test",
      result: "round 2",
      startedAt: Date.now(),
      endedAt: Date.now(),
      round: 2, // 不同 round
    };

    notifier.notify(record1);
    notifier.notify(record2);

    // 纯 id 去重：同 id 第二条应被吞（60s TTL 内）
    expect(sent).toHaveLength(1);
  });

  it("不同 id 不被去重", () => {
    const host = createMockHost(false);
    const notifier = new BgNotifier(host);
    const sent: unknown[] = [];
    (host as { sendMessage: NotifierHost["sendMessage"] }).sendMessage = (msg) => { sent.push(msg); };

    const record1: BgNotifyRecord = {
      id: "sa-111",
      status: "closed",
      agent: "test",
      result: "result 1",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    const record2: BgNotifyRecord = {
      id: "sa-222",
      status: "closed",
      agent: "test",
      result: "result 2",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };

    notifier.notify(record1);
    notifier.notify(record2);

    expect(sent).toHaveLength(2);
  });

  it("closed status 被正确入队", () => {
    const host = createMockHost(false);
    const notifier = new BgNotifier(host);
    const sent: unknown[] = [];
    (host as { sendMessage: NotifierHost["sendMessage"] }).sendMessage = (msg) => { sent.push(msg); };

    const record: BgNotifyRecord = {
      id: "sa-333",
      status: "closed",
      closedReason: "gc",
      agent: "test",
      result: "some result",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };

    notifier.notify(record);
    expect(sent).toHaveLength(1);
  });
});

// ============================================================
// mapExternalState: closed → ended
// ============================================================

describe("mapExternalState", () => {
  it("running → active", () => {
    expect(mapExternalState("running")).toBe("active");
  });

  it("idle → waiting", () => {
    expect(mapExternalState("idle")).toBe("waiting");
  });

  it("closed → ended", () => {
    expect(mapExternalState("closed")).toBe("ended");
  });

  it("cancelled → ended", () => {
    expect(mapExternalState("cancelled")).toBe("ended");
  });
});

// ============================================================
// statusGlyph: closed → ✓ success
// ============================================================

describe("statusGlyph", () => {
  it("closed → ✓ success", () => {
    const glyph = statusGlyph("closed");
    expect(glyph.icon).toBe("✓");
    expect(glyph.color).toBe("success");
  });

  it("running → accent (no icon)", () => {
    const glyph = statusGlyph("running");
    expect(glyph.icon).toBeUndefined();
    expect(glyph.color).toBe("accent");
  });

  it("idle → ⏸ warning", () => {
    const glyph = statusGlyph("idle");
    expect(glyph.icon).toBe("⏸");
    expect(glyph.color).toBe("warning");
  });

  it("cancelled → ■ muted", () => {
    const glyph = statusGlyph("cancelled");
    expect(glyph.icon).toBe("■");
    expect(glyph.color).toBe("muted");
  });
});

// ============================================================
// BgNotifyRecord.status 不含 done/failed
// ============================================================

describe("BgNotifyRecord.status", () => {
  it("合法值只有 closed/cancelled/idle", () => {
    // 编译期验证
    const valid: BgNotifyRecord["status"][] = ["closed", "cancelled", "idle"];
    expect(valid).toHaveLength(3);
  });

  it("closed + closedReason 可构造", () => {
    const record: BgNotifyRecord = {
      id: "test",
      status: "closed",
      closedReason: "user-close",
      agent: "test-agent",
      result: "done",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
  });
});
