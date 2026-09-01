// src/execution/__tests__/spawned-children.test.ts
//
// spawnedChildren Map + getChildByRecord + killAllSpawnedChildren 单元测试（M2-B1）。
//
// M2-B1 把 spawnedChildren 从 Set<ChildProcess> 改为 Map<recordId, ChildProcess>，
// 建立 record→child 映射（busy 投递定位活进程用，设计决策 6）。本文件测 Map API 核心行为：
//   - getChildByRecord：set 后能查到；delete 后查不到；未注册返回 undefined
//   - killAllSpawnedChildren：遍历 .values() kill + clear；单 child kill 抛错不阻断
//   - [R1 D6③] killAllSpawnedChildren 编排扩容：先触发 engine registry dispose（触发不等待），
//     后杀 per-record children——dispose 全部先于任何 kill（D6① 时序）
//
// [T2-⑤ / LC-2] 跳过条件变更（原「跳过 child.killed=true」契约已废止）：killed=发过
// kill 请求 ≠ 已死，只有 exitCode/signalCode 非 null（已确认死亡）才跳过；killed 但
// 未确认死亡的 child 补 SIGKILL 升级（SIGTERM 可能被无视）。新契约的完整行为矩阵见
// kill-all-escalation.test.ts（runSpawn 集成面），本文件保留纯 Map 遍历面的正/反例。
//
// 直接操作模块级 spawnedChildren（afterEach clear 防泄漏），不依赖 runSpawn/spawn/fs。

import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// mock core logger：session-runner 与 engine/registry 共用同一 facade 模块（两处
// `../../core/logger.ts` 解析到同一文件），本 mock 对二者同时生效。
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import type { EnginePort } from "../engine/port.ts";
import { clearEngines, getEngine, registerEngine } from "../engine/registry.ts";
import { getChildByRecord, killAllSpawnedChildren, spawnedChildren } from "../session-runner.ts";

/**
 * 假 child：只关心 killed 标记 + kill 调用（killAllSpawnedChildren 遍历用）。
 * extra 可注入 exitCode/signalCode（模拟已确认死亡的形态）。
 */
function makeFakeChild(
  killed = false,
  extra: Partial<Pick<ChildProcess, "exitCode" | "signalCode">> = {},
): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  return { killed, kill: vi.fn(), ...extra } as unknown as ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
  };
}

/** 带 dispose 的假引擎（编排测试用——dispose 触发顺序记进 events，与 child kill 事件共序）。 */
function makeDisposingEngine(
  id: string,
  events: string[],
  disposeImpl?: () => Promise<void>,
): EnginePort {
  return {
    id,
    capabilities: () => ({
      schemaEnforcement: "native",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "none",
      sessionRead: "outcome-only",
      resume: "unsupported",
      interrupt: "kill-only",
      permissionMode: "fixed",
    }),
    probe: () =>
      Promise.resolve({ ok: true, engineVersion: "0.0.0-test", checks: [{ name: "stub", ok: true }] }),
    run: () => Promise.reject(new Error("fake engine: run not implemented")),
    interact: () => Promise.resolve({ ok: false, code: "engine_capability_unsupported", message: "stub" }),
    read: () => Promise.resolve({ engineId: id, turns: [], source: "outcome-only" }),
    dispose: disposeImpl ?? (() => {
      events.push(`dispose:${id}`);
      return Promise.resolve();
    }),
  };
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

  it("[T2-⑤] killed 但未确认死亡 → 不跳过，补 SIGKILL 升级（killed=发过请求≠已死）", () => {
    const alive = makeFakeChild(false);
    const killedNotClosed = makeFakeChild(true); // SIGTERM 已发、exit/signal 仍 null
    spawnedChildren.set("rec-1", alive);
    spawnedChildren.set("rec-2", killedNotClosed);

    const n = killAllSpawnedChildren();

    expect(n).toBe(2);
    expect(alive.kill).toHaveBeenCalledWith("SIGTERM");
    // dispose 是最后兜底，对 killed-not-closed 直接升级 SIGKILL（不再赌 SIGTERM 生效）
    expect(killedNotClosed.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawnedChildren.size).toBe(0);
  });

  it("[T2-⑤] killed 且已确认死亡（signalCode 非 null）→ 跳过，不重复发信号", () => {
    const dead = makeFakeChild(true, { signalCode: "SIGTERM" });
    spawnedChildren.set("rec-1", dead);

    const n = killAllSpawnedChildren();

    expect(n).toBe(0);
    expect(dead.kill).not.toHaveBeenCalled();
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

describe("killAllSpawnedChildren 编排扩容（R1 D6③：先引擎 dispose 后 per-record children）", () => {
  afterEach(() => {
    spawnedChildren.clear();
    // registry 是进程级全局状态（Symbol.for 槽），防用例间 fake 引擎泄漏串扰
    clearEngines();
  });

  it("先全部触发已实例化引擎 dispose，后遍历杀 children（D6① 时序：dispose 先于 SIGTERM）", () => {
    const events: string[] = [];
    registerEngine("e-alpha", () => makeDisposingEngine("e-alpha", events));
    registerEngine("e-beta", () => makeDisposingEngine("e-beta", events));
    getEngine("e-alpha"); // disposeEngines 只遍历已实例化单例，须先实例化
    getEngine("e-beta");

    const c1 = makeFakeChild();
    const c2 = makeFakeChild();
    c1.kill.mockImplementation(() => {
      events.push("kill:rec-a");
    });
    c2.kill.mockImplementation(() => {
      events.push("kill:rec-b");
    });
    spawnedChildren.set("rec-a", c1);
    spawnedChildren.set("rec-b", c2);

    const n = killAllSpawnedChildren();

    expect(n).toBe(2);
    // 时序断言（不依赖穿插序）：最后一个 dispose 的索引 < 第一个 kill 的索引
    const disposeIdx = events
      .map((e, i) => (e.startsWith("dispose:") ? i : -1))
      .filter((i) => i >= 0);
    const firstKill = events.findIndex((e) => e.startsWith("kill:"));
    expect(disposeIdx.length).toBe(2);
    expect(firstKill).toBeGreaterThan(Math.max(...disposeIdx));
    expect(spawnedChildren.size).toBe(0);
  });

  it("引擎 dispose 同步 throw 不阻断 children 清理（best-effort 编排，catch 记日志继续）", () => {
    const events: string[] = [];
    registerEngine(
      "throwy",
      () =>
        makeDisposingEngine("throwy", events, () => {
          throw new Error("dispose boom");
        }),
    );
    getEngine("throwy");
    const child = makeFakeChild();
    child.kill.mockImplementation(() => {
      events.push("kill:rec-1");
    });
    spawnedChildren.set("rec-1", child);

    expect(() => killAllSpawnedChildren()).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(spawnedChildren.size).toBe(0);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("[engine-registry] engine 'throwy' dispose threw synchronously"),
    );
  });

  it("引擎仅注册工厂未实例化 → 不触发 dispose 也不实例化（停机路径不反向创建资源）", () => {
    const events: string[] = [];
    const engine = makeDisposingEngine("unused", events);
    registerEngine("unused", () => engine);
    const child = makeFakeChild();
    child.kill.mockImplementation(() => {
      events.push("kill:rec-1");
    });
    spawnedChildren.set("rec-1", child);

    const n = killAllSpawnedChildren();

    expect(n).toBe(1);
    expect(events).toEqual(["kill:rec-1"]); // 无 dispose 事件混入
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
