// src/execution/__tests__/reconcile-sweep.test.ts
//
// [W4] 注册对账 sweep 单测：差集判据（record 终态 ∪ 已归档/不存在 → 补发；
// active → 跳过；type=workflow/未知 → 保守跳过）、写法（appendEntry 权威落盘 +
// 尽力 emit；appendEntry 抛错不计入且不 emit）。差集输入 session 文件用
// mkdtempSync 自建自删（禁触真实数据目录）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runReconcileSweep, type SupervisedRecordState } from "../round-supervisor/reconcile-sweep.ts";

let tmpDir: string;
let sessionFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-sweep-"));
  sessionFile = path.join(tmpDir, "session.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.restoreAllMocks();
});

function writeSessionFile(lines: unknown[]): void {
  fs.writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
}

function reg(id: string, type = "subagent"): unknown {
  return { customType: "pending:register", data: { id, type, name: id, registeredAt: 1, sessionId: "sess" } };
}

function unreg(id: string): unknown {
  return { customType: "pending:unregister", data: { id, reason: "completed" } };
}

function makeDeps(overrides: {
  states?: Map<string, SupervisedRecordState>;
  appendEntry?: (customType: string, data: unknown) => void;
  emit?: (channel: string, data: unknown) => void;
  sessionFile?: string;
} = {}) {
  const states = overrides.states ?? new Map<string, SupervisedRecordState>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const deps = {
    sessionFile: overrides.sessionFile ?? sessionFile,
    lookupRecordState: (id: string): SupervisedRecordState => states.get(id) ?? "missing",
    appendEntry: overrides.appendEntry ?? ((customType: string, data: unknown) => appended.push({ customType, data })),
    emit: overrides.emit ?? ((channel: string, data: unknown) => emitted.push({ channel, data })),
  };
  return { deps, appended, emitted };
}

describe("runReconcileSweep 差集补发", () => {
  it("register(subagent) × record 终态 → 补发 unregister（appendEntry 权威 + 尽力 emit），reason 取 closedReason", () => {
    writeSessionFile([reg("bg-1")]);
    const { deps, appended, emitted } = makeDeps({
      states: new Map([["bg-1", { terminal: true, closedReason: "cancelled" }]]),
    });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-1"]);
    expect(appended).toEqual([
      { customType: "pending:unregister", data: { id: "bg-1", reason: "cancelled", status: "cancelled" } },
    ]);
    expect(emitted).toHaveLength(1);
  });

  it("record 已归档/不存在（查不到）→ 视同终态补注销（reason=expired）", () => {
    writeSessionFile([reg("bg-gone")]);
    const { deps, appended } = makeDeps({ states: new Map() }); // lookup 恒 missing
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-gone"]);
    expect(appended[0].data).toEqual({ id: "bg-gone", reason: "expired", status: "expired" });
  });

  it("record 活跃 → 保守跳过（不写不 emit）", () => {
    writeSessionFile([reg("bg-live")]);
    const { deps, appended, emitted } = makeDeps({ states: new Map([["bg-live", "active"]]) });
    const result = runReconcileSweep(deps);
    expect(result.skippedActive).toEqual(["bg-live"]);
    expect(appended).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("type=workflow / 未知类型 → 保守跳过（workflow runId 不在 RecordStore，查不到 ≠ 终态）", () => {
    writeSessionFile([reg("wf-1", "workflow"), reg("bad-1", "mystery"), reg("bt-1", "bash")]);
    const { deps, appended } = makeDeps({ states: new Map() });
    const result = runReconcileSweep(deps);
    expect(result.skippedNonSubagent.sort()).toEqual(["bad-1", "bt-1", "wf-1"]);
    expect(appended).toHaveLength(0);
  });

  it("已注销的 id 不出现在差集 → 不补发", () => {
    writeSessionFile([reg("bg-1"), unreg("bg-1")]);
    const { deps, appended } = makeDeps();
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual([]);
    expect(appended).toHaveLength(0);
  });

  it("unregister 之后的重注册重新进差集（同 id 重 register = 后写胜出）", () => {
    writeSessionFile([reg("bg-1"), unreg("bg-1"), reg("bg-1")]);
    const { deps, appended } = makeDeps();
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-1"]);
    expect(appended).toHaveLength(1);
  });

  it("sessionFile 缺失 → 空跑（不抛）", () => {
    const { deps } = makeDeps({ sessionFile: undefined });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual([]);
  });

  it("session 文件不可读（未 flush/被删）→ 空跑", () => {
    const { deps } = makeDeps({ sessionFile: path.join(tmpDir, "nope.jsonl") });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual([]);
  });

  it("appendEntry 抛错 → 不计 reconciled、不 emit（差集残留交下次 sweep 重试）", () => {
    writeSessionFile([reg("bg-1"), reg("bg-2")]);
    const { deps, emitted } = makeDeps({
      appendEntry: (customType, data) => {
        if ((data as { id: string }).id === "bg-1") throw new Error("EACCES");
      },
    });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-2"]);
    expect(emitted.map((e) => (e.data as { id: string }).id)).toEqual(["bg-2"]);
  });

  it("坏行（截断 JSON）跳过不拖垮其余条目", () => {
    fs.writeFileSync(sessionFile, [JSON.stringify(reg("bg-1")), '{"customType":"pending:regis'].join("\n"), "utf-8");
    const { deps, appended } = makeDeps({
      states: new Map([["bg-1", { terminal: true, closedReason: "gc" }]]),
    });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-1"]);
    expect(appended).toHaveLength(1);
  });
});
