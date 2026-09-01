// src/execution/__tests__/service-kill-escalation.test.ts
//
// [u-svc / T2④ / LC-2] killRecordChildWithEscalation 真实现行为（服务侧 kill 收敛入口，
// 无 SpawnRunState 调用方）：
//   - child 不在 spawnedChildren / 已 killed → no-op（与旧 `child && !child.killed` 守卫
//     语义逐字对齐）；
//   - SIGTERM 后 30s 未见 exit → SIGKILL 升级（SIGTERM 被无视的幽灵进程防线）；
//   - exit 到达 → 升级 timer 自动清除；
//   - 同 record 重复调用先清旧升级 timer（防叠加）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeChild } from "./helpers/spawn-mock.ts";
import {
  _resetServiceKillStateForTest,
  killRecordChildWithEscalation,
  spawnedChildren,
} from "../session-runner.ts";

const SIGKILL_ESCALATION_MS = 30_000;

describe("T2④ killRecordChildWithEscalation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    _resetServiceKillStateForTest();
    spawnedChildren.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetServiceKillStateForTest();
    spawnedChildren.clear();
  });

  it("is a no-op when the record has no registered child", () => {
    expect(() => killRecordChildWithEscalation("sa-missing", "test")).not.toThrow();
  });

  it("is a no-op when the child already received a kill request (escalation owned by prior path)", () => {
    const child = new FakeChild();
    child.killed = true;
    const killSpy = vi.spyOn(child, "kill");
    spawnedChildren.set("sa-killed", child);
    killRecordChildWithEscalation("sa-killed", "test");
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("sends SIGTERM and escalates to SIGKILL after 30s without exit", async () => {
    const child = new FakeChild();
    const killSpy = vi.spyOn(child, "kill");
    spawnedChildren.set("sa-escalate", child);

    killRecordChildWithEscalation("sa-escalate", "closeChatIdle");
    expect(killSpy).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(SIGKILL_ESCALATION_MS - 1);
    expect(killSpy).toHaveBeenCalledTimes(1); // 未到期不升级

    await vi.advanceTimersByTimeAsync(1);
    expect(killSpy).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("clears the escalation timer when the child exits in time", async () => {
    const child = new FakeChild();
    const killSpy = vi.spyOn(child, "kill");
    spawnedChildren.set("sa-exit", child);

    killRecordChildWithEscalation("sa-exit", "cancelBackground");
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(SIGKILL_ESCALATION_MS + 1_000);
    expect(killSpy).toHaveBeenCalledTimes(1); // 只有 SIGTERM，无 SIGKILL
  });

  it("repeated calls clear the previous escalation timer (no stacking)", async () => {
    const child = new FakeChild();
    const killSpy = vi.spyOn(child, "kill");
    spawnedChildren.set("sa-repeat", child);

    killRecordChildWithEscalation("sa-repeat", "first");
    await vi.advanceTimersByTimeAsync(10_000);
    // 第二次调用前 child.killed 已为 true（首次 SIGTERM 置位）→ no-op 路径
    killRecordChildWithEscalation("sa-repeat", "second");
    expect(killSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SIGKILL_ESCALATION_MS);
    expect(killSpy).toHaveBeenCalledTimes(2); // 首次 timer 正常触发（未被重复调用清掉）
    expect(killSpy).toHaveBeenNthCalledWith(2, "SIGKILL");
  });
});
