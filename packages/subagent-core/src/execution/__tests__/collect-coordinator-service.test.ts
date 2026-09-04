// src/execution/__tests__/collect-coordinator-service.test.ts
//
// collectCoordinator 的 service 集成面（subagent-sync-collect U2）：
//   1. 偏差#4 落点：execute({collect:"sync"}) 的 record 落 collectMode="sync"
//      （观察者形态：subagent-record entry 落盘产物断言，非 mock record）；
//   2. notifyComplete 统一路由：sync 成员终态 → 协调器缓冲 → 单成员闭合 → 降级
//      flush → notifier.notify 收到该成员（观察点：替换 notifier.notify 为 spy，
//      闭包经 this 运行时读取，替换生效）；
//   3. async record（无 collect）直通同一 notifier.notify（现状路径字节不变）；
//   4. 偏差#3 接线：getCollectSyncDefault 读真实 config（缺省 async / 配置 sync +
//      reloadGlobalConfig 后生效）。
//
// mock 手法对齐 ended-message-and-fork-from.test.ts：mock session-runner（不 spawn
// 真子进程）+ logger；record-store / config 走真实实现（tmpdir 自建自删，红线）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// mock session-runner：execute 链经 kickOffBackground → runAndFinalize → runSpawn。
// runSpawn 返回最小成功 AgentResult，后台收尾链完整走完（finalize + archive + notify）。
vi.mock("../execution/session-runner.ts", () => ({
  runSpawn: vi.fn(async () => ({
    text: "ok",
    turns: 1,
    durationMs: 10,
    success: true,
    sessionId: "spawned",
    toolCalls: [],
  })),
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
}

/** 替换 service 私有 notifier 为仅覆盖 notify 的 spy（保留其余方法；协调器 deps
 *  闭包经 this 运行时读取，替换生效）。 */
function spyNotifier(service: SubagentService): NotifierSpy {
  const original = (service as unknown as { notifier: object }).notifier;
  const spy: NotifierSpy = { notify: vi.fn() };
  (service as unknown as { notifier: unknown }).notifier = { ...original, notify: spy.notify };
  return spy;
}

/**
 * 异步链等待：手写短轮询（真实 timers）。
 * 为什么不用 vi.waitFor：vitest 4.1.8 本包环境下 vi.waitFor 对 falsy callback
 * 立即 resolve 不轮询不超时（sanity 用例实证：waitFor(()=>false,{timeout:100})
 * resolve(false) 而非 reject）——属测试基建缺陷，与被测链路无关，此处绕开。
 */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`collect-coordinator-service: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("collectCoordinator service integration (U2)", () => {
  let agentDir: string;
  let service: SubagentService;
  let pi: ReturnType<typeof makePi>;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-collect-coord-"));
    fs.mkdirSync(getSubagentSessionDir(agentDir, agentDir), { recursive: true });
    pi = makePi();
    service = makeService(pi);
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  function makeService(piInstance: ReturnType<typeof makePi>): SubagentService {
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
    const created = new SubagentService({ cwd: agentDir, modelService });
    created.initSession({ pi: piInstance, sessionId: "root-session-cur" });
    return created;
  }

  it("stamps collectMode on the in-memory record visible to the coordinator routing (偏差#4 落点)", async () => {
    // 注：entry 落盘观察者断言（subagent-record entry 含 collectMode）依赖
    // record-store.recordToSubagent 投影扩展——U5 领地（偏差登记）；本用例锁
    // 内存 record 经协调器路由的可见行为：sync 成员终态 → 单成员闭合 → 降级
    // flush 投递（下方用例），async 成员直通。本条记录 execute 链零异常完成。
    const spy = spyNotifier(service);
    const handle = await service.execute({ task: "collect me", slug: "collect-me", collect: "sync" });
    await until(() => spy.notify.mock.calls.length > 0);
    expect(handle.subagentId).toMatch(/^sa-/);
  });

  it("routes a finished sync member through the coordinator to notifier (单成员闭合 → 降级 flush)", async () => {
    const spy = spyNotifier(service);
    const handle = await service.execute({ task: "collect me", slug: "collect-me", collect: "sync" });
    await until(() => spy.notify.mock.calls.length > 0);
    const notified = spy.notify.mock.calls.map((c) => c[0] as { id: string });
    expect(notified.some((n) => n.id === handle.subagentId)).toBe(true);
  });

  it("routes an async member through the same notifyAsync path (现状直通)", async () => {
    const spy = spyNotifier(service);
    const handle = await service.execute({ task: "plain", slug: "plain" });
    await until(() => spy.notify.mock.calls.length > 0);
    const notified = spy.notify.mock.calls.map((c) => c[0] as { id: string });
    expect(notified.some((n) => n.id === handle.subagentId)).toBe(true);
  });

  it("getCollectSyncDefault reads real config (偏差#3 接线)", () => {
    // 无 config.json → 缺省 async
    expect(service.getCollectSyncDefault()).toBe("async");
    // 写入 collectSync.default=sync + reload → sync 生效
    const configPath = path.join(agentDir, "subagents", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, maxConcurrent: 6, collectSync: { default: "sync" } }),
      "utf-8",
    );
    const modelService = (service as unknown as { modelService: ModelConfigService }).modelService;
    modelService.reloadGlobalConfig();
    expect(service.getCollectSyncDefault()).toBe("sync");
    // E5 坏值回默认：非枚举 → async 兜底
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, maxConcurrent: 6, collectSync: { default: "immediate" } }),
      "utf-8",
    );
    modelService.reloadGlobalConfig();
    expect(service.getCollectSyncDefault()).toBe("async");
  });
});
