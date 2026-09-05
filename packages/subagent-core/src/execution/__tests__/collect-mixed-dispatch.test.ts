// src/execution/__tests__/collect-mixed-dispatch.test.ts
//
// A8 混派正交 service 级 e2e（subagent-sync-collect U8；设计 §4 A8 验收行 /
// §3.1.4 数据流）：**同轮** 2 个 collect:"sync" + 1 个 async（不传 collect）全部经
// SubagentService.execute 真链（mock 仅 session-runner 的 runSpawn——时序受控终态，
// 与 collect-coordinator-service.test.ts 同手法）。
//
// 与协调器层既有覆盖（collect-coordinator.test.ts "async records never block sync
// closure" / notify-batch.test.ts "混派正交"）的差异：那两层 stub 了 notifyAsync /
// toNotifyRecord / listRecords；本文件走 service.execute 全链（record 落 collectMode →
// kickOffBackground → runAndFinalize → notifyComplete → 协调器真路由 → notifier 真
// spy），锁「同轮混派」在真实投递接线下的两个方向：
//   1. async 成员先终态：立即走 notify 直通（不被 sync 批扣留），批零投递；
//      随后 sync 成员逐个终态 → 恰 1 次 notifyBatch、成员恰为 2 个 sync id；
//   2. sync 批先闭合（async 仍在跑）：两个 sync 背靠背紧窗口终态（U8 拆批盲窗的
//      精确复现形态）→ 去抖合批单批 flush 不等 async；随后 async 终态才收到
//      自己的单条 notify。
//
// 三视角（TEST-STRATEGY §3）：
//   - 使用者黑盒：派发方可见形态 = async 通知即时到达、sync 结果合并为单条批；
//   - 构建者白盒：协调器路由去向 + notifier spy 调用面；
//   - 观察者形态：pi.appendEntry 落盘的 subagent-record entry（collectMode 标记）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock, runSpawnMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  runSpawnMock: vi.fn(async () => ({
    text: "ok",
    turns: 1,
    durationMs: 10,
    success: true,
    sessionId: "spawned",
    toolCalls: [],
  })),
}));
vi.mock("../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock 路径自检（impl-plan 偏差 #6 教训）：从 __tests__ 解析必须命中真实模块
// src/execution/session-runner.ts——"../execution/session-runner.ts" 解析到不存在的
// execution/execution/ 会让拦截静默失效（mock 测试不验证真链）。
vi.mock("../session-runner.ts", () => ({
  runSpawn: runSpawnMock,
  killAllSpawnedChildren: vi.fn(),
  killRecordChildWithEscalation: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
  spawnedChildren: new Map(),
}));

import { getSubagentSessionDir } from "../path-encoding.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelRegistryLike } from "../model-resolver.ts";
import { SubagentService } from "../subagent-service.ts";

const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
    on: vi.fn(),
  };
}

interface NotifierSpy {
  notify: ReturnType<typeof vi.fn>;
  notifyBatch: ReturnType<typeof vi.fn>;
}

function spyNotifier(service: SubagentService): NotifierSpy {
  const original = (service as unknown as { notifier: object }).notifier;
  const spy: NotifierSpy = { notify: vi.fn(), notifyBatch: vi.fn(() => true) };
  (service as unknown as { notifier: unknown }).notifier = {
    ...original,
    notify: spy.notify,
    notifyBatch: spy.notifyBatch,
  };
  return spy;
}

/** 手写短轮询（本包 vitest 4.1.8 环境 vi.waitFor 失效——impl-plan §7 环境注意）。 */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`collect-mixed-dispatch: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const spawnOk = () => ({
  text: "ok",
  turns: 1,
  durationMs: 10,
  success: true,
  sessionId: "spawned",
  toolCalls: [],
});

/** 受控 runSpawn：每次调用挂起返回 resolver，测试按成员序号放行终态。
 *  resolver 在 runSpawn 实际调用时（execute 异步链内）才构造——release 函数按
 *  索引延迟取用，不能在挂起注册时立刻闭包捕获（彼时尚为 undefined）。 */
function controlledSpawns(n: number): Array<(v?: ReturnType<typeof spawnOk>) => void> {
  const resolvers: Array<(v: ReturnType<typeof spawnOk>) => void> = [];
  for (let i = 0; i < n; i += 1) {
    runSpawnMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolvers[i] = res;
        }),
    );
  }
  return Array.from({ length: n }, (_, i) => (v?: ReturnType<typeof spawnOk>) =>
    resolvers[i]!(v ?? spawnOk()),
  );
}

describe("A8 混派正交 service e2e（同轮 2 sync + 1 async，U8）", () => {
  let agentDir: string;
  let service: SubagentService;
  let pi: ReturnType<typeof makePi>;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-mixed-dispatch-"));
    fs.mkdirSync(getSubagentSessionDir(agentDir, agentDir), { recursive: true });
    pi = makePi();
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    const modelRegistry: ModelRegistryLike = {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
    modelService.initModel({
      sessionId: "root-session-cur",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
      modelRegistry,
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi, sessionId: "root-session-cur" });
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("async 先终态：即时直通 notify（不被 sync 批扣留）→ sync 逐个终态 → 恰 1 批 2 成员", async () => {
    const spy = spyNotifier(service);
    // 同轮三连派发：2 sync + 1 async（派发顺序 sync, sync, async——同一条消息内的
    // 混派形态；runSpawn 调用序与 execute 序一致）
    const [doneSync1, doneSync2, doneAsync] = controlledSpawns(3);
    const hSync1 = await service.execute({ task: "s1", slug: "sync-one", collect: "sync" });
    const hSync2 = await service.execute({ task: "s2", slug: "sync-two", collect: "sync" });
    const hAsync = await service.execute({ task: "a1", slug: "async-one" });
    await until(() => runSpawnMock.mock.calls.length >= 3); // 三个受控 promise 均已构造

    // async 成员先终态：立即单条 notify（现状路径），批零投递、零扣留
    doneAsync();
    await until(() => spy.notify.mock.calls.length > 0);
    expect(spy.notifyBatch).not.toHaveBeenCalled();
    expect(spy.notify.mock.calls).toHaveLength(1);
    expect((spy.notify.mock.calls[0]![0] as { id: string }).id).toBe(hAsync.subagentId);

    // sync-1 终态：sync-2 仍 running → 缓冲不闭合（async 通知不重复）
    doneSync1();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spy.notifyBatch).not.toHaveBeenCalled();
    expect(spy.notify.mock.calls).toHaveLength(1);

    // sync-2 终态：闭合 → 恰 1 次批投递，成员恰为 2 个 sync id（async 不入批）
    doneSync2();
    await until(() => spy.notifyBatch.mock.calls.length > 0);
    expect(spy.notifyBatch.mock.calls).toHaveLength(1);
    const batch = spy.notifyBatch.mock.calls[0]![0] as { id: string }[];
    expect(batch.map((m) => m.id).sort()).toEqual([hSync1.subagentId, hSync2.subagentId].sort());
    // async 通知面恒 1（批闭合不重发 async）
    expect(spy.notify.mock.calls).toHaveLength(1);
  });

  it("sync 批先闭合（async 仍在跑）：背靠背紧窗口合批单批；async 随后独立单条 notify", async () => {
    const spy = spyNotifier(service);
    const [doneSync1, doneSync2, doneAsync] = controlledSpawns(3);
    const hSync1 = await service.execute({ task: "s1", slug: "sync-one", collect: "sync" });
    const hSync2 = await service.execute({ task: "s2", slug: "sync-two", collect: "sync" });
    const hAsync = await service.execute({ task: "a1", slug: "async-one" });
    await until(() => runSpawnMock.mock.calls.length >= 3);

    // 两个 sync 同步段背靠背终态（窄于 finalize 链宽度——U8 拆批盲窗的精确复现形态：
    // 先 archive 的成员 route 时，后者的 notifyComplete 尚在 finalize 链间隙，闭合
    // 扫描看不见）。协调器去抖合批窗口把间隙内 route 的成员并入同一批：修复前此处
    // 产出 [["sa-1"],["sa-2"]] 两条单成员批，修复后稳定单批（50ms 错峰 workaround
    // 已移除——本用例即拆批盲窗的回归守卫）。
    doneSync1();
    doneSync2();
    await until(() => spy.notifyBatch.mock.calls.length > 0);
    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    const batch = spy.notifyBatch.mock.calls[0]![0] as { id: string }[];
    expect(batch.map((m) => m.id).sort()).toEqual([hSync1.subagentId, hSync2.subagentId].sort());
    // async 未终态：批闭合不产生 async 通知
    expect(spy.notify).not.toHaveBeenCalled();

    // async 随后终态：独立单条 notify（与批互不串扰）
    doneAsync();
    await until(() => spy.notify.mock.calls.length > 0);
    expect(spy.notify.mock.calls).toHaveLength(1);
    expect((spy.notify.mock.calls[0]![0] as { id: string }).id).toBe(hAsync.subagentId);
    expect(spy.notifyBatch).not.toHaveBeenCalledTimes(2);
  });

  it("观察者形态：同轮混派三 record 的落盘 entry 各自携带正确 collectMode", async () => {
    const spy = spyNotifier(service);
    const [, , doneAsync] = controlledSpawns(3);
    const hSync1 = await service.execute({ task: "s1", slug: "sync-one", collect: "sync" });
    const hSync2 = await service.execute({ task: "s2", slug: "sync-two", collect: "sync" });
    const hAsync = await service.execute({ task: "a1", slug: "async-one" });
    await until(() => runSpawnMock.mock.calls.length >= 3);
    doneAsync();
    await until(() => spy.notify.mock.calls.length > 0);
    // 批不必闭合即可断言落盘（register 期 entry 即带 collectMode）：
    // sync 成员 entry 带 collectMode:"sync"，async 成员 entry 无该键（缺省 async）
    const entriesBy = (id: string) =>
      pi.appendEntry.mock.calls
        .filter((c) => c[0] === "subagent-record")
        .map((c) => c[1] as Record<string, unknown>)
        .filter((d) => d["id"] === id);
    expect(entriesBy(hSync1.subagentId).some((d) => d["collectMode"] === "sync")).toBe(true);
    expect(entriesBy(hSync2.subagentId).some((d) => d["collectMode"] === "sync")).toBe(true);
    expect(
      entriesBy(hAsync.subagentId).every((d) => !("collectMode" in d) || d["collectMode"] === undefined),
    ).toBe(true);
  });
});

// 【已知盲窗·已修复（U8 授权修复轮）】背靠背拆批竞态（机理回顾：runAndFinalize 的
// completeRecord+archive 先于 .then 链 notifyComplete，成员 B 已终态归档但未路由时
// A 的闭合检测看不到 B → flush([A])，随后 B route 再 flush([B])）已在
// collect-coordinator.ts 落地修复：闭合首次满足不立即 flush，改 setTimeout(0)
// 同宏任务去抖合批——排程窗口内新 route（finalize 链间隙的成员）并入缓冲后一并
// flush；触发时重验闭合条件（窗口内新 running 反转则留缓冲等其终态重排程）。
// E9 交互：dispose 经 convertPendingSyncBufferToAsync 先 cancelScheduledFlush
//（取消而非同步 flush——放任触发会与逐条转 async 写账双通道并发 → 双投递），缓冲
// 原样保留供转换；E1 无交集（session_start 时点排程必已被取消，补发直走 notifyBatch，
// 账本 sync-batch:<hash> 幂等兑底）。上方第二用例已改回背靠背紧窗口断言作回归守卫。
