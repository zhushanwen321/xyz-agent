// lifecycle-predicates 单测（v4 B-1；W6 随拆依赖改写：读点改 core 侧状态镜像）。
// 验证 isIdle/isResumable/hasLiveProcessHandle 在两态收敛后的判定逻辑。
// 依赖 lifecycle-manager 模块级 idleTimers 与 core 侧 spawnedChildren 镜像
// （engine/host/spawned-children.ts，含 inproc 过渡桥并读语义），beforeEach 重置隔离。

import { describe, it, expect, beforeEach } from "vitest";

import {
  armIdleTimer,
  disarmIdleTimer,
  _resetLifecycleState,
} from "../lifecycle-manager.ts";
// inproc 权威 map 仅用于等价性用例（证明并读行为与改线前逐点一致）
import { spawnedChildren } from "../engine/engines/pi/session-runner.ts";
import {
  coreSpawnedChildrenMirror,
  _resetCoreSpawnedChildrenMirrorForTest,
} from "../engine/host/spawned-children.ts";
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

/** 构造最小 ChildProcess fake（镜像注册只读 pid/killed）。 */
function fakeChild(killed: boolean): ChildProcess {
  // 测试 fake：被测代码仅读 .pid/.killed，其余字段不可达，用 unknown 中转满足类型。
  return { pid: 4242, killed } as unknown as ChildProcess;
}

describe("lifecycle-predicates (v4 B-1)", () => {
  beforeEach(() => {
    _resetLifecycleState();
    spawnedChildren.clear();
    _resetCoreSpawnedChildrenMirrorForTest();
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

  describe("hasLiveProcessHandle（W6 改读镜像）", () => {
    it("no mirror entry → false", () => {
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

    it("mirror entry running (not killed) → true", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: false });
      expect(hasLiveProcessHandle("sa-test")).toBe(true);
    });

    it("mirror entry killed → false", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: true });
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

    it("mirror markKilled 置死后 → false", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: false });
      coreSpawnedChildrenMirror().markKilled("sa-test");
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

    it("inproc 过渡桥并读：runSpawn 内部注册（只落 inproc map）→ true（行为与改线前一致）", () => {
      spawnedChildren.set("sa-test", fakeChild(false));
      expect(hasLiveProcessHandle("sa-test")).toBe(true);
    });

    it("inproc 过渡桥并读：inproc child killed → false", () => {
      spawnedChildren.set("sa-test", fakeChild(true));
      expect(hasLiveProcessHandle("sa-test")).toBe(false);
    });

    it("镜像与 inproc 同 recordId 重 spawn：以活端为准（任一面活即活）", () => {
      coreSpawnedChildrenMirror().register("sa-test", { pid: 1, killed: true });
      spawnedChildren.set("sa-test", fakeChild(false));
      expect(hasLiveProcessHandle("sa-test")).toBe(true);
    });
  });

  describe("isResumable (= running && !hasLiveProcessHandle)", () => {
    it("running + no live process → true (Path B / 跨重启)", () => {
      expect(isResumable(makeRecord({ status: "running" }))).toBe(true);
    });

    it("running + live process (镜像) → false (Path A 保活 / 正在执行)", () => {
      const rec = makeRecord({ status: "running" });
      coreSpawnedChildrenMirror().register(rec.id, { pid: 1, killed: false });
      expect(isResumable(rec)).toBe(false);
    });

    it("running + live process (inproc 并读) → false（改线前同判）", () => {
      const rec = makeRecord({ status: "running" });
      spawnedChildren.set(rec.id, fakeChild(false));
      expect(isResumable(rec)).toBe(false);
    });

    it("closed + no live process → false (终态不可 resume)", () => {
      expect(isResumable(makeRecord({ status: "closed" }))).toBe(false);
    });

    it("closed + live process → false (终态优先)", () => {
      const rec = makeRecord({ status: "closed" });
      coreSpawnedChildrenMirror().register(rec.id, { pid: 1, killed: false });
      expect(isResumable(rec)).toBe(false);
    });
  });
});
