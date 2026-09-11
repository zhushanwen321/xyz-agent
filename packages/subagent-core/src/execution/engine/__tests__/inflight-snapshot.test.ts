// inflight-snapshot.test.ts —— core→壳在途事件出口 + EnginePort.inFlightSnapshot? 缺省语义
//（u7a，设计权威源：docs/design/crash-forensics-and-watchdog.md §3.3 D5）。
//
// 三视角：
//   ①使用者（壳层 reporter 视角）——setInFlightListener 注册后，core 状态迁移点
//     （子进程注册/移除、idle timer arm）推来最新绝对计数快照；getInFlightSnapshot
//     随时可拉（初始上报数据源）。
//   ②构建者——计数 = 双谓词过滤（hasLiveProcessHandle && !hasIdleTimer，与
//     notify-host hasRunningBackground 同源）：活句柄且无 armed idle timer 才算在途，
//     Path A 保活（timer armed）不算——D5 防推迟恒真的核心裁决。
//   ③观察者——EnginePort 可选成员向后兼容：pi 引擎不实现（undefined = 无在途），
//     zcode 引擎实现（快照面在场）；出口监听者抛错不反噬 core。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import {
  armIdleTimer,
  disarmIdleTimer,
  _resetLifecycleState,
} from "../../lifecycle-manager.ts";
import {
  getInFlightSnapshot,
  notifyInFlightChanged,
  setInFlightListener,
  type InFlightSnapshot,
} from "../inflight-snapshot.ts";
import type { EnginePort } from "../port.ts";
import { registerSpawnedChildForRecord, spawnedChildren } from "../engines/pi/session-runner.ts";
import { PiEngine } from "../engines/pi/pi-engine.ts";
import { ZcodeEngine } from "../engines/zcode/zcode-engine.ts";

/** 最小 fake 子进程（EventEmitter + killed/pid 字段——hasLiveProcessHandle 消费面）。 */
function makeFakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  (child as { pid?: number }).pid = 4242;
  (child as { killed: boolean }).killed = false;
  return child;
}

beforeEach(() => {
  _resetLifecycleState();
  setInFlightListener(null);
});

afterEach(() => {
  // 清理本测试注册的句柄（走 close 事件路径，顺带覆盖摘除迁移点），防跨用例泄漏。
  for (const [id, child] of [...spawnedChildren]) {
    spawnedChildren.delete(id);
    (child as unknown as EventEmitter).emit("close");
  }
  _resetLifecycleState();
  setInFlightListener(null);
});

describe("getInFlightSnapshot：双谓词绝对计数（D5 求值位置 = 状态所在进程）", () => {
  it("空态 → 0（无任何 subagent 的 session 初始上报数据源）", () => {
    expect(getInFlightSnapshot()).toEqual({ inFlight: 0 });
  });

  it("注册活句柄 → 1；arm idle timer（Path A 保活）→ 0；disarm → 1", () => {
    const id = "sa-inflight-arm";
    registerSpawnedChildForRecord(id, makeFakeChild());
    expect(getInFlightSnapshot().inFlight).toBe(1);

    armIdleTimer(id, () => undefined, 60_000);
    expect(getInFlightSnapshot().inFlight).toBe(0);

    disarmIdleTimer(id);
    expect(getInFlightSnapshot().inFlight).toBe(1);
  });

  it("killed 句柄不算活（hasLiveProcessHandle 的 !killed 子句）", () => {
    const id = "sa-inflight-killed";
    const child = makeFakeChild();
    registerSpawnedChildForRecord(id, child);
    (child as { killed: boolean }).killed = true;
    expect(getInFlightSnapshot().inFlight).toBe(0);
  });

  it("多 record 混合形态：在途/保活/垂死并存时按谓词逐一过滤", () => {
    const running = makeFakeChild();
    const keepAlive = makeFakeChild();
    const dying = makeFakeChild();
    (dying as { killed: boolean }).killed = true;
    registerSpawnedChildForRecord("sa-inflight-run", running);
    registerSpawnedChildForRecord("sa-inflight-keep", keepAlive);
    registerSpawnedChildForRecord("sa-inflight-dying", dying);
    armIdleTimer("sa-inflight-keep", () => undefined, 60_000);
    expect(getInFlightSnapshot().inFlight).toBe(1);
  });
});

describe("notifyInFlightChanged：迁移点 → 壳层监听者（同步 fire-and-forget）", () => {
  it("监听者收到最新快照（迁移时刻求值，非注册时刻）", () => {
    const seen: InFlightSnapshot[] = [];
    setInFlightListener((s) => seen.push({ ...s }));

    notifyInFlightChanged();
    expect(seen).toEqual([{ inFlight: 0 }]);

    registerSpawnedChildForRecord("sa-inflight-notify", makeFakeChild());
    notifyInFlightChanged();
    expect(seen[seen.length - 1]).toEqual({ inFlight: 1 });
  });

  it("监听者抛错不反噬 core（壳层故障不打断生命周期主链）", () => {
    setInFlightListener(() => {
      throw new Error("shell reporter bug");
    });
    expect(() => notifyInFlightChanged()).not.toThrow();
  });

  it("无监听者时 no-op；注册覆盖语义（后注册者收到，先注册者不再收）", () => {
    expect(() => notifyInFlightChanged()).not.toThrow();

    const first: InFlightSnapshot[] = [];
    const second: InFlightSnapshot[] = [];
    setInFlightListener((s) => first.push(s));
    setInFlightListener((s) => second.push(s));
    notifyInFlightChanged();
    expect(first).toEqual([]);
    expect(second).toEqual([{ inFlight: 0 }]);
  });

  it("registerSpawnedChildForRecord / close 摘除自动触发通知（迁移点接线证据）", () => {
    const seen: InFlightSnapshot[] = [];
    setInFlightListener((s) => seen.push(s));

    const child = makeFakeChild();
    registerSpawnedChildForRecord("sa-inflight-auto", child);
    expect(seen.at(-1)).toEqual({ inFlight: 1 });

    child.emit("close");
    expect(seen.at(-1)).toEqual({ inFlight: 0 });
  });
});

describe("EnginePort.inFlightSnapshot? 可选成员缺省语义（D5：pi 不实现，zcode 实现）", () => {
  it("pi 引擎不实现 → undefined（= 无引擎侧在途面，pi 形态由 extension 聚合上报覆盖）", () => {
    // 经 EnginePort 接口面访问（可选成员缺席的正当形态）；具体类 PiEngine 无此声明，
    // 消费方必须走 port 类型——本身就是「pi 不实现」契约的一部分。
    const pi: EnginePort = new PiEngine({ getService: () => null });
    expect(pi.inFlightSnapshot).toBeUndefined();
  });

  it("zcode 引擎实现 → 同步快照；运行时未初始化（从未 run / 已 dispose）恒 0（空闲常驻≠在途）", () => {
    const engine: EnginePort = new ZcodeEngine({ engineDataDir: () => "/tmp/zcode-inflight-test" });
    expect(typeof engine.inFlightSnapshot).toBe("function");
    expect(engine.inFlightSnapshot?.()).toEqual({ inFlight: 0 });
  });

  it("未实现该成员的引擎对象仍满足 EnginePort（向后兼容，可选成员不强制）", () => {
    // 结构化证据：EnginePort 的既有可选成员扩展先例（listModels/validateModel/dispose）
    // 同款——缺席成员不破坏实现关系。以 pi 引擎为真实样本断言（它只实现到 dispose 为止）。
    const pi: EnginePort = new PiEngine({ getService: () => null });
    expect(pi.id).toBe("pi");
    expect(typeof pi.capabilities).toBe("function");
    expect(pi.inFlightSnapshot).toBeUndefined();
  });
});
