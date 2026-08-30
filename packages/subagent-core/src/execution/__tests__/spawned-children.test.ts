// src/execution/__tests__/spawned-children.test.ts
//
// spawnedChildren Map + getChildByRecord + killAllSpawnedChildren 单元测试（M2-B1）。
//
// M2-B1 把 spawnedChildren 从 Set<ChildProcess> 改为 Map<recordId, ChildProcess>，
// 建立 record→child 映射（busy 投递定位活进程用，设计决策 6）。本文件测 Map API 核心行为：
//   - getChildByRecord：set 后能查到；delete 后查不到；未注册返回 undefined
//   - killAllSpawnedChildren：遍历 .values() kill + clear；跳过 child.killed=true；单 child kill 抛错不阻断
//
// 直接操作模块级 spawnedChildren（afterEach clear 防泄漏），不依赖 runSpawn/spawn/fs。

import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { getChildByRecord, killAllSpawnedChildren, spawnedChildren } from "../session-runner.ts";

/** 假 child：只关心 killed 标记 + kill 调用（killAllSpawnedChildren 遍历用）。 */
function makeFakeChild(killed = false): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  return { killed, kill: vi.fn() } as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
}

describe("spawnedChildren Map + getChildByRecord (M2-B1)", () => {
  afterEach(() => {
    spawnedChildren.clear();
  });

  it("set(recordId, child) 后 getChildByRecord 能查到；未注册返回 undefined", () => {
    const child = makeFakeChild();
    spawnedChildren.set("rec-1", child);
    expect(getChildByRecord("rec-1")).toBe(child);
    expect(getChildByRecord("rec-2")).toBeUndefined();
  });

  it("delete(recordId) 后 getChildByRecord 返回 undefined（close/error 回调语义）", () => {
    const child = makeFakeChild();
    spawnedChildren.set("rec-1", child);
    spawnedChildren.delete("rec-1");
    expect(getChildByRecord("rec-1")).toBeUndefined();
  });

  it("killAllSpawnedChildren 遍历 .values() 对每个未 killed child kill + clear", () => {
    const c1 = makeFakeChild();
    const c2 = makeFakeChild();
    spawnedChildren.set("rec-a", c1);
    spawnedChildren.set("rec-b", c2);

    const n = killAllSpawnedChildren();

    expect(n).toBe(2);
    expect(c1.kill).toHaveBeenCalledTimes(1);
    expect(c2.kill).toHaveBeenCalledTimes(1);
    expect(spawnedChildren.size).toBe(0);
  });

  it("killAllSpawnedChildren 跳过 child.killed=true（不重复 kill 已 kill 的）", () => {
    const alive = makeFakeChild(false);
    const alreadyKilled = makeFakeChild(true);
    spawnedChildren.set("rec-1", alive);
    spawnedChildren.set("rec-2", alreadyKilled);

    const n = killAllSpawnedChildren();

    expect(n).toBe(1);
    expect(alive.kill).toHaveBeenCalledTimes(1);
    expect(alreadyKilled.kill).not.toHaveBeenCalled();
    expect(spawnedChildren.size).toBe(0);
  });

  it("killAllSpawnedChildren 对单个 child kill 抛错不阻断其他（best-effort catch）", () => {
    const ok = makeFakeChild();
    const throwy = makeFakeChild();
    throwy.kill.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    spawnedChildren.set("rec-1", ok);
    spawnedChildren.set("rec-2", throwy);

    const n = killAllSpawnedChildren();

    // throwy 抛错被 catch，不计入 n；ok 正常 kill。两者都调过 kill，Map 已 clear。
    expect(n).toBe(1);
    expect(ok.kill).toHaveBeenCalledTimes(1);
    expect(throwy.kill).toHaveBeenCalledTimes(1);
    expect(spawnedChildren.size).toBe(0);
  });
});
