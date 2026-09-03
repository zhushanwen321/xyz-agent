// lifecycle-predicates 单测（v4 B-1）。
// 验证 isIdle/isResumable/hasLiveProcessHandle 在两态收敛后的判定逻辑。
// 依赖 lifecycle-manager 模块级 idleTimers 与 session-runner.spawnedChildren（单例 Map），
// beforeEach 重置隔离。

import { describe, it, expect, beforeEach } from "vitest";

import {
  armIdleTimer,
  disarmIdleTimer,
  _resetLifecycleState,
} from "../lifecycle-manager.ts";
import { spawnedChildren } from "../engine/engines/pi/session-runner.ts";
import type { ChildProcess } from "node:child_process";
import type { ExecutionRecord } from "../types.ts";

import { hasLiveProcessHandle, isIdle, isResumable } from "../lifecycle-predicates.ts";

/** 构造最小 ExecutionRecord（status 默认 running）。 */
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "sa-test",
    agent: "general-purpose",
    model: "test/model",
    thinkingLevel: undefined,
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: Date.now(),
    rootSessionId: "root",
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    round: 0,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    controller: undefined,
    ...overrides,
  } as ExecutionRecord;
}

/** 构造最小 ChildProcess fake（hasLiveProcessHandle 只读 .killed）。 */
function fakeChild(killed: boolean): ChildProcess {
  // 测试 fake：被测代码仅读 .killed，其余字段不可达，用 unknown 中转满足 Map 类型。
  return { killed } as unknown as ChildProcess;
}

describe("lifecycle-predicates (v4 B-1)", () => {
  beforeEach(() => {
    _resetLifecycleState();
    spawnedChildren.clear();
  });

  describe("isIdle (= hasIdleTimer)", () => {
    it("armed idle timer → true", () => {
      const rec = makeRecord();
      armIdleTimer(rec.id, () => {});
      expect(isIdle(rec)).toBe(true);
    });

    it("no idle timer → false", () => {
      expect(isIdle(makeRecord())).toBe(false);
    });

    it("disarmed timer → false", () => {
      const rec = makeRecord();
      armIdleTimer(rec.id, () => {});
      disarmIdleTimer(rec.id);
      expect(isIdle(rec)).toBe(false);
    });
  });

  describe("hasLiveProcessHandle", () => {
    it("no child in map → false", () => {
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

    it("child present and not killed → true", () => {
      spawnedChildren.set("sa-test", fakeChild(false));
      expect(hasLiveProcessHandle("sa-test")).toBe(true);
    });

    it("child present but killed → false", () => {
      spawnedChildren.set("sa-test", fakeChild(true));
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });
  });

  describe("isResumable (= running && !hasLiveProcessHandle)", () => {
    it("running + no live process → true (Path B / 跨重启)", () => {
      expect(isResumable(makeRecord({ status: "running" }))).toBe(true);
    });

    it("running + live process → false (Path A 保活 / 正在执行)", () => {
      const rec = makeRecord({ status: "running" });
      spawnedChildren.set(rec.id, fakeChild(false));
      expect(isResumable(rec)).toBe(false);
    });

    it("closed + no live process → false (终态不可 resume)", () => {
      expect(isResumable(makeRecord({ status: "closed" }))).toBe(false);
    });

    it("closed + live process → false (终态优先)", () => {
      const rec = makeRecord({ status: "closed" });
      spawnedChildren.set(rec.id, fakeChild(false));
      expect(isResumable(rec)).toBe(false);
    });
  });
});
