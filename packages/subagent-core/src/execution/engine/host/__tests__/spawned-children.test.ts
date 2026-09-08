// core 侧 spawnedChildren 状态镜像 + inproc 过渡桥 单测（W6，impl-plan §2.6 首条）。
// 覆盖：公共 API 双写（镜像 + inproc 委托）、杀链委托、镜像整体置死、
// hasLiveProcessHandleCore 并读语义（与改线前行为逐点一致）。

import { describe, it, expect, beforeEach } from "vitest";

import type { ChildProcess } from "node:child_process";
import {
  _resetServiceKillStateForTest,
  spawnedChildren,
} from "../../engines/pi/session-runner.ts";
import {
  _resetCoreSpawnedChildrenMirrorForTest,
  coreSpawnedChildrenMirror,
  hasLiveProcessHandleCore,
  killAllSpawnedChildren,
  killRecordChildWithEscalation,
  registerSpawnedChildForRecord,
} from "../spawned-children.ts";

/** 最小 ChildProcess fake（kill 链需要 kill/once；exitCode/signalCode null = 未确认死亡）。 */
function fakeChild(id: string): ChildProcess & { killCalls: string[] } {
  const killCalls: string[] = [];
  return {
    pid: 10_000 + (id.charCodeAt(0) % 1000),
    killed: false,
    exitCode: null,
    signalCode: null,
    killCalls,
    kill(sig?: NodeJS.Signals) {
      killCalls.push(sig ?? "SIGTERM");
      (this as { killed: boolean }).killed = true;
      return true;
    },
    once() {
      return this;
    },
  } as unknown as ChildProcess & { killCalls: string[] };
}

describe("core 侧 spawnedChildren 状态镜像（W6）", () => {
  beforeEach(() => {
    spawnedChildren.clear();
    _resetCoreSpawnedChildrenMirrorForTest();
    _resetServiceKillStateForTest();
  });

  it("registerSpawnedChildForRecord 双写：镜像 + inproc 权威 map（收割记账行为保持）", () => {
    const child = fakeChild("sa-a");
    registerSpawnedChildForRecord("sa-a", child);
    expect(spawnedChildren.get("sa-a")).toBe(child);
    expect(coreSpawnedChildrenMirror().getChildByRecord("sa-a")).toMatchObject({
      pid: child.pid,
      killed: false,
    });
  });

  it("hasLiveProcessHandleCore：镜像注册后 true；markKilled 后 false", () => {
    const child = fakeChild("sa-a");
    registerSpawnedChildForRecord("sa-a", child);
    expect(hasLiveProcessHandleCore("sa-a")).toBe(true);
    coreSpawnedChildrenMirror().markKilled("sa-a");
    // inproc 并读面：child 仍活（kill 未发）→ 过渡期以活端为准
    expect(hasLiveProcessHandleCore("sa-a")).toBe(true);
    child.kill("SIGTERM");
    // inproc 面置死（killed=true）→ 两面皆死
    expect(hasLiveProcessHandleCore("sa-a")).toBe(false);
  });

  it("killRecordChildWithEscalation：镜像置死 + inproc 升级杀链委托（SIGTERM 先发）", () => {
    const child = fakeChild("sa-a");
    registerSpawnedChildForRecord("sa-a", child);
    killRecordChildWithEscalation("sa-a", "test escalation");
    expect(child.killCalls).toContain("SIGTERM");
    expect(coreSpawnedChildrenMirror().getChildByRecord("sa-a")?.killed).toBe(true);
    expect(hasLiveProcessHandleCore("sa-a")).toBe(false);
  });

  it("killAllSpawnedChildren：inproc 全量收割 + 镜像整体置死（失效语义 2+3）", () => {
    const a = fakeChild("sa-a");
    const b = fakeChild("sa-b");
    registerSpawnedChildForRecord("sa-a", a);
    registerSpawnedChildForRecord("sa-b", b);
    const killed = killAllSpawnedChildren();
    expect(killed).toBe(2);
    expect(spawnedChildren.size).toBe(0);
    expect(coreSpawnedChildrenMirror().snapshot()).toEqual([]);
    expect(hasLiveProcessHandleCore("sa-a")).toBe(false);
    expect(hasLiveProcessHandleCore("sa-b")).toBe(false);
  });

  it("并读：runSpawn 内部注册（只落 inproc map，不经公共 API）→ 仍判定活（改线前同判）", () => {
    const child = fakeChild("sa-c");
    spawnedChildren.set("sa-c", child);
    expect(hasLiveProcessHandleCore("sa-c")).toBe(true);
    child.kill("SIGKILL");
    expect(hasLiveProcessHandleCore("sa-c")).toBe(false);
  });

  it("同 recordId 重 spawn：镜像覆盖旧句柄（与 inproc Map 覆盖语义同构）", () => {
    const old = fakeChild("sa-a");
    registerSpawnedChildForRecord("sa-a", old);
    old.kill("SIGTERM");
    const fresh = fakeChild("sa-b");
    registerSpawnedChildForRecord("sa-a", fresh);
    expect(coreSpawnedChildrenMirror().getChildByRecord("sa-a")?.pid).toBe(fresh.pid);
    expect(hasLiveProcessHandleCore("sa-a")).toBe(true);
  });
});
