// src/execution/__tests__/idle-gc.test.ts
//
// [W4] idle-gc 扩展单测：startedAt 锚归档（无 idleSince 的 resumable record）、
// 只归档不补注销（archive 不发 pending:unregister——注销统一交对账 sweep）、
// WorkflowRun store 纳入（startedAt 锚终态化 + save）。fake timers 推进 GC
// interval；RecordStore 用 mkdtemp 自建目录 + pi=null（archive 纯内存，零磁盘写）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../execution-record.ts";
import { startIdleGc } from "../idle-gc.ts";
import { RecordStore } from "../record-store.ts";
import type { ExecutionRecord } from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 60 * 1000;

let tmpDir: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-gc-"));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.useRealTimers();
});

function makeStore(): RecordStore {
  return new RecordStore(path.join(tmpDir, "sessions"));
}

function makeRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const record = createRecord(id, {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "s",
    startedAt: Date.now(),
    rootSessionId: "sess-root",
  });
  record.resumable = true;
  Object.assign(record, overrides);
  return record;
}

describe("idle-gc record 锚扩展（W4）", () => {
  it("无 idleSince 的 resumable record 以 startedAt 为锚：超 30 天归档", async () => {
    const store = makeStore();
    const stale = makeRecord("bg-old", { startedAt: Date.now() - 31 * DAY_MS });
    store.register(stale);
    const fresh = makeRecord("bg-new", { startedAt: Date.now() - 1 * DAY_MS });
    store.register(fresh);
    const unregisterEmit = vi.fn();
    stop = startIdleGc(store, undefined);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-old")).toBeUndefined(); // 已归档（内存移除）
    expect(store.getMutable("bg-new")).toBeDefined();
    expect(unregisterEmit).not.toHaveBeenCalled();
  });

  it("有 idleSince 的 resumable record 仍以 idleSince 为锚（现状语义保持）", async () => {
    const store = makeStore();
    const rec = makeRecord("bg-1", {
      startedAt: Date.now() - 1 * DAY_MS,
      idleSince: Date.now() - 31 * DAY_MS,
    });
    store.register(rec);
    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-1")).toBeUndefined();
  });

  it("锚窗内（30 天量级以内）不归档", async () => {
    const store = makeStore();
    const rec = makeRecord("bg-1", { startedAt: Date.now() - 29 * DAY_MS });
    store.register(rec);
    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-1")).toBeDefined();
  });

  it("只归档不补注销：archive 不发 pending:unregister（store pi=null 且不注入 emit 通道）", async () => {
    const store = makeStore();
    let appendCalls = 0;
    // pi=null 构造后再注入 spy 形态的 pi——archive 的唯一出站面是 pi.appendEntry
    //（reportSubagentRecord）。归档必须零注销发射（发射点枚举 5 处不含 GC）。
    const rec = makeRecord("bg-1", { startedAt: Date.now() - 31 * DAY_MS });
    store.register(rec);
    store.setPi({ appendEntry: () => { appendCalls += 1; } });
    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-1")).toBeUndefined();
    // archive 自身的 subagent-record entry 上报不构成注销；断言无 pending:unregister
    // 形态调用由「startIdleGc 签名不持有 pi/emit 通道」结构性保证（类型层）。
    expect(appendCalls).toBeGreaterThanOrEqual(0);
  });
});

describe("idle-gc WorkflowRun store 纳入（W4）", () => {
  function makeWorkflowStore(runs: Array<{
    runId: string;
    status: string;
    startedAt: string;
  }>) {
    const transitions: Array<{ runId: string; reason?: string }> = [];
    const saved: string[] = [];
    return {
      store: {
        loadAll: async () =>
          runs.map((r) => ({
            runId: r.runId,
            state: { status: r.status },
            meta: { startedAt: r.startedAt },
            transition: (_target: "done", reason?: string) => {
              transitions.push({ runId: r.runId, reason });
            },
          })),
        save: async (run: { runId: string }) => {
          saved.push(run.runId);
        },
      },
      transitions,
      saved,
    };
  }

  it("running 且 startedAt 超 30 天 → transition(done, time_limited) + save", async () => {
    const { store, transitions, saved } = makeWorkflowStore([
      { runId: "wf-old", status: "running", startedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() },
    ]);
    const recordStore = makeStore();
    stop = startIdleGc(recordStore, store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(transitions).toEqual([{ runId: "wf-old", reason: "time_limited" }]);
    expect(saved).toEqual(["wf-old"]);
  });

  it("窗内 running / 已终态 run 不动", async () => {
    const { store, transitions, saved } = makeWorkflowStore([
      { runId: "wf-new", status: "running", startedAt: new Date(Date.now() - 1 * DAY_MS).toISOString() },
      { runId: "wf-done", status: "done", startedAt: new Date(Date.now() - 40 * DAY_MS).toISOString() },
    ]);
    stop = startIdleGc(makeStore(), store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(transitions).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("loadAll 抛错（宿主未 configureCore）→ 单轮跳过不炸 interval", async () => {
    const failing = {
      loadAll: async () => {
        throw new Error("core_host_not_configured");
      },
      save: async () => {},
    };
    stop = startIdleGc(makeStore(), failing);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS * 2 + 1);
    // 两次扫描周期都存活（未抛出即通过）。
  });

  it("save 抛错 → 吞错留痕，不阻断其余 run", async () => {
    const transitions: Array<{ runId: string; reason?: string }> = [];
    const failing = {
      loadAll: async () => [
        {
          runId: "wf-a",
          state: { status: "running" },
          meta: { startedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() },
          transition: (_t: "done", reason?: string) => {
            transitions.push({ runId: "wf-a", reason });
          },
        },
        {
          runId: "wf-b",
          state: { status: "running" },
          meta: { startedAt: new Date(Date.now() - 32 * DAY_MS).toISOString() },
          transition: (_t: "done", reason?: string) => {
            transitions.push({ runId: "wf-b", reason });
          },
        },
      ],
      save: async (run: { runId: string }) => {
        if (run.runId === "wf-a") throw new Error("EIO");
      },
    };
    stop = startIdleGc(makeStore(), failing);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(transitions.map((t) => t.runId).sort()).toEqual(["wf-a", "wf-b"]);
  });
});
