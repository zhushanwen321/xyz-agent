// mirror 单元测试（W2，impl-plan §2.2「镜像失效语义」逐条）：
//   1. 未收 childSpawned 前 = 无句柄（getChildByRecord undefined 等价）；
//   2. killAll 整体置死（killed=true + 状态广播）；
//   3. 置死后清空，isResumable 回落「无句柄」；
//   killed 必含判据 = `entry !== undefined && !entry.killed`。

import { describe, expect, it } from "vitest";

import { SpawnedChildrenMirror } from "../mirror.ts";

describe("SpawnedChildrenMirror", () => {
  it("未收 childSpawned 前 = 无句柄：getChildByRecord/hasLiveProcessHandle/isResumable 全部回落无句柄", () => {
    const mirror = new SpawnedChildrenMirror();
    expect(mirror.getChildByRecord("rec-1")).toBeUndefined();
    expect(mirror.getEntry(4242)).toBeUndefined();
    expect(mirror.hasLiveProcessHandle("rec-1")).toBe(false);
    expect(mirror.isResumable("rec-1")).toBe(false);
  });

  it("childSpawned 落项后句柄可达；childStateChanged 更新状态（killed 必含）", () => {
    const mirror = new SpawnedChildrenMirror();
    mirror.recordSpawned(101, "rec-1");
    expect(mirror.getChildByRecord("rec-1")).toMatchObject({ pid: 101, recordId: "rec-1", state: "running", killed: false });
    expect(mirror.isResumable("rec-1")).toBe(true);

    mirror.recordStateChanged({ pid: 101, recordId: "rec-1", state: "exited", killed: true, exitCode: 0 });
    expect(mirror.getChildByRecord("rec-1")).toMatchObject({ state: "exited", killed: true, exitCode: 0 });
    // exited + killed → 谓词回落 false（判据 child !== undefined && !child.killed）
    expect(mirror.isResumable("rec-1")).toBe(false);
  });

  it("killAll：全部镜像项整体置死（killed=true + state=exited）+ 逐项广播 + 清空", () => {
    const mirror = new SpawnedChildrenMirror();
    mirror.recordSpawned(101, "rec-1");
    mirror.recordSpawned(102, "rec-2");
    const events: Array<{ reason: string; pid?: number; recordId?: string }> = [];
    mirror.onChange((e) => events.push(e));

    mirror.killAll();

    // 置死广播先于清空（失效语义 2：宿主谓词/通知先看到 killed=true）
    const killEvents = events.filter((e) => e.reason === "killedAll");
    expect(killEvents.map((e) => e.pid).sort()).toEqual([101, 102]);
    // 广播后镜像清空（失效语义 3：isResumable 回落「无句柄」）
    expect(mirror.size).toBe(0);
    expect(mirror.getChildByRecord("rec-1")).toBeUndefined();
    expect(mirror.snapshot()).toEqual([]);
  });

  it("killAll 幂等：空镜像也发一次广播（订阅方依赖收敛信号）", () => {
    const mirror = new SpawnedChildrenMirror();
    const events: string[] = [];
    mirror.onChange((e) => events.push(e.reason));
    mirror.killAll();
    expect(events).toEqual(["killedAll"]);
  });

  it("同一 pid 的 childStateChanged 覆盖原项；多 record 各自独立", () => {
    const mirror = new SpawnedChildrenMirror();
    mirror.recordSpawned(101, "rec-1");
    mirror.recordSpawned(102, "rec-2");
    mirror.recordStateChanged({ pid: 101, recordId: "rec-1", state: "exited", killed: false, exitCode: 0 });
    expect(mirror.size).toBe(2);
    expect(mirror.getChildByRecord("rec-1")).toMatchObject({ state: "exited", killed: false });
    expect(mirror.isResumable("rec-2")).toBe(true);
  });
});
