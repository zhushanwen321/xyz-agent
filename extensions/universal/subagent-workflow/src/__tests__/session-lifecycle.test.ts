// src/__tests__/session-lifecycle.test.ts
//
// u-4 行为变更点测试（设计 §3.1/D1/D2，impl-plan 验收 4「各自配测试」）：
//
//   1. bootstrap seam 直测——setupSessionLifecycle(pi, ctx, deps) 以 deps 注入
//      fake（worktreeManager/createServices/createRunStore）验证装配行为，
//      不挂载 index.ts、零整类 mock（设计 §3.1「使用者视角」样例的落地）。
//   2. 守卫合一——原 pi.__workflowRun 内联守卫与 getDeps 守卫两份重复合并为
//      单一 getWorkflowDeps 出口后，两个消费点（返回错误对象 / throw）对同一
//      失败态产生同源同消息的失败形态（错误消息逐字保留，crash-recovery 已锁
//      "store unavailable" / "loadAll failed" 子串）。
//
// mock 面说明：第 2 组用例必须挂载 index.ts（守卫消费点是其闭包内符号），沿
// crash-recovery.test.ts 的 module 级 vi.mock 先例；打桩面收敛是 u-5b 领地。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules（在 import 前声明）──

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/user/.pi/agent",
}));
vi.mock("@zhushanwen/subagent-core/execution/worktree-manager.ts", () => ({
  WorktreeManager: class {
    scan = vi.fn(async () => {});
    cleanup = vi.fn();
    create = vi.fn();
    collectPatch = vi.fn();
    registerPid = vi.fn();
  },
}));
vi.mock("@zhushanwen/subagent-core/execution/session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: vi.fn(),
}));

// seam 组（第 1 组 describe）直接 import session-lifecycle——它消费的默认实现走
// 下列 mock；seam 用例全部经 deps 注入 fake，mock 仅作默认实现的安全网。
vi.mock("@zhushanwen/subagent-core/execution/model-config-service.ts", () => ({
  ModelConfigService: class {
    initModel = vi.fn();
    reloadGlobalConfig = vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } }));
  },
  getModelConfigService: () => null,
  setModelConfigService: vi.fn(),
}));
vi.mock("@zhushanwen/subagent-core/execution/subagent-service.ts", () => ({
  SubagentService: class {
    initSession = vi.fn();
    setUiRequestHandler = vi.fn();
    recoverManifestTmpFiles = vi.fn(async () => ({ deleted: 0, recovered: 0 }));
    startGcTimer = vi.fn();
  },
  getSubagentService: () => null,
  setSubagentService: vi.fn(),
}));

// 守卫组（挂载 index.ts）的 store 可控点：index.ts 走默认 createRunStore（真实
// JsonlRunStore 类经 mock 替换），loadAll 行为由 mountWithLoadAll 注入。
const { mockStoreLoadAll } = vi.hoisted(() => ({
  mockStoreLoadAll: vi.fn(async () => []),
}));
vi.mock("../jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockStoreLoadAll;
    save = vi.fn(async () => {});
    dispose = vi.fn(async () => {});
    flushPendingSaves = vi.fn(async () => {});
  },
}));

// 守卫组（第 2 组 describe）挂载 index.ts 所需的 interface 层 mock（防真实
// registerTool 打在 Proxy pi 上）；registerWorkflowTool 捕获 lazyDeps 供断言。
const { mockRegisterWorkflowTool } = vi.hoisted(() => ({
  mockRegisterWorkflowTool: vi.fn(),
}));
vi.mock("../interface/subagent-tool.ts", () => ({
  registerSubagentTool: vi.fn(),
}));
vi.mock("../interface/subagents.ts", () => ({
  registerSubagentsCommand: vi.fn(),
}));
vi.mock("../interface/bg-notify-render.ts", () => ({
  renderBgNotifyMessage: vi.fn(),
}));
vi.mock("../interface/tool-workflow.ts", () => ({
  registerWorkflowTool: mockRegisterWorkflowTool,
}));
vi.mock("../interface/tool-workflow-script.ts", () => ({
  registerWorkflowScriptTool: vi.fn(),
}));
vi.mock("../interface/commands.ts", () => ({
  registerWorkflowsCommand: vi.fn(),
}));

// ── import 被测模块 ──
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { IDENTITY_CUSTOM_TYPE } from "@zhushanwen/subagent-core/execution/session-reconstructor.ts";
import type { WorkflowRun as WorkflowRunType } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import { WorkflowRun } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import { Budget } from "@zhushanwen/subagent-core/orchestration/models/budget.ts";
import { Trace } from "@zhushanwen/subagent-core/orchestration/models/trace.ts";
import subagentsExtension from "../index.ts";
import {
  setupSessionLifecycle,
  type SessionLifecycleDeps,
} from "../session-lifecycle.ts";

// ── helpers ──

interface EntryRecord {
  customType: string;
  data: unknown;
}

/** 最小 typed fake pi：appendEntry/events.emit/on/sendMessage 四成员（设计 §3.1 fake 形态）。 */
function createFakePi(): {
  pi: ExtensionAPI;
  entries: EntryRecord[];
  emits: Array<{ channel: string; data: unknown }>;
} {
  const entries: EntryRecord[] = [];
  const emits: Array<{ channel: string; data: unknown }> = [];
  const noop = (): void => { /* fake */ };
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
    events: {
      emit: (channel: string, data: unknown) => {
        emits.push({ channel, data });
      },
    },
    on: noop,
    sendMessage: noop,
  } as unknown as ExtensionAPI;
  return { pi, entries, emits };
}

/** 最小 ExtensionContext fake。 */
function createFakeCtx(sessionId = "session-seam-1"): ExtensionContext {
  return {
    cwd: "/home/user/project",
    mode: "tui",
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
    model: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => "/home/user/.pi/agent/sessions/seam.jsonl",
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;
}

/** 构造可重水合的 WorkflowRun（reconstruct 跳过 I1 校验）。 */
function makeRun(runId: string, status: "running" | "done"): WorkflowRunType {
  return WorkflowRun.reconstruct(
    runId,
    { scriptSource: "execute() {}", args: {}, scriptName: "test", scriptPath: "/fake/test.js" },
    {
      status,
      reason: status === "done" ? "completed" : undefined,
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

/** 构造可控 fake store（注入 deps.createRunStore）。 */
function makeFakeStore(loadAll: () => Promise<WorkflowRunType[]>): {
  loadAll: () => Promise<WorkflowRunType[]>;
  save: (run: WorkflowRunType) => Promise<void>;
  dispose: () => Promise<void>;
} {
  return {
    loadAll,
    save: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStoreLoadAll.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── 组 1：bootstrap seam（deps 注入直测） ────────────────────────────────────────

describe("setupSessionLifecycle — bootstrap seam（设计 §3.1）", () => {
  it("deps.worktreeManager 注入 fake：session_start 恰好 scan 一次（ADR-035 reaper 一行行为一个注入点）", async () => {
    const { pi } = createFakePi();
    const fakeWtm = { scan: vi.fn(async () => {}) };
    const deps: SessionLifecycleDeps = { worktreeManager: fakeWtm };

    await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(fakeWtm.scan).toHaveBeenCalledTimes(1);
    expect(fakeWtm.scan).toHaveBeenCalledWith();
  });

  it("deps.createServices 注入 fake：装配走注入工厂，其 service 供 manifest 恢复与 SAR 委托", async () => {
    const { pi } = createFakePi();
    const fakeService = {
      recoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
    };
    const fakeModelService = {
      reloadGlobalConfig: vi.fn(() => ({ status: "absent", config: { version: 1, maxConcurrent: 6 } })),
    };
    const createServices = vi.fn(() => ({
      service: fakeService,
      modelService: fakeModelService,
      reused: false,
    }));
    const deps: SessionLifecycleDeps = {
      createServices: createServices as unknown as SessionLifecycleDeps["createServices"],
    };

    const result = await setupSessionLifecycle(pi, createFakeCtx("session-svc-1"), deps);

    expect(createServices).toHaveBeenCalledTimes(1);
    expect(fakeService.recoverManifestTmpFiles).toHaveBeenCalledTimes(1);
    // 装配结果回传：sessionId/storeHealthy/lastEngine（absent → 归一 'pi'）
    expect(result.sessionId).toBe("session-svc-1");
    expect(result.storeHealthy).toBe(true);
    expect(result.lastEngine).toBe("pi");
  });

  it("deps.createRunStore 注入 fake：loadAll 成功 → storeHealthy=true，runs 重水合", async () => {
    const { pi } = createFakePi();
    const doneRun = makeRun("wf-seam-done", "done");
    const fakeStore = makeFakeStore(vi.fn(async () => [doneRun]));
    const deps: SessionLifecycleDeps = {
      createRunStore: vi.fn(() => fakeStore as never),
    };

    const result = await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(result.storeHealthy).toBe(true);
    expect(result.runs.has("wf-seam-done")).toBe(true);
    expect(result.store).toBe(fakeStore);
  });

  it("store.loadAll 失败 → result.storeHealthy=false（MF-1 fail-fast 语义经 result 回传）", async () => {
    const { pi } = createFakePi();
    const fakeStore = makeFakeStore(vi.fn(async () => {
      throw new Error("disk corruption");
    }));
    const deps: SessionLifecycleDeps = { createRunStore: () => fakeStore as never };

    const result = await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(result.storeHealthy).toBe(false);
  });

  it("kill-9 恢复：running run 转 done,failed + pending:unregister emit + save 落盘", async () => {
    const { pi, emits } = createFakePi();
    const runningRun = makeRun("wf-seam-k9", "running");
    const save = vi.fn(async () => {});
    const fakeStore = makeFakeStore(vi.fn(async () => [runningRun]));
    fakeStore.save = save;
    const deps: SessionLifecycleDeps = { createRunStore: () => fakeStore as never };

    const result = await setupSessionLifecycle(pi, createFakeCtx(), deps);

    expect(runningRun.state.status).toBe("done");
    expect(runningRun.state.reason).toBe("failed");
    expect(runningRun.state.error).toContain("Process killed");
    const unregister = emits.find((e) => e.channel === "pending:unregister");
    expect(unregister).toBeDefined();
    expect(unregister!.data).toEqual({ id: "wf-seam-k9", reason: "failed" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.storeHealthy).toBe(true);
  });

  it("子进程 env 注入时 identity custom entry 落 appendEntry（13 字段随迁块）", async () => {
    vi.stubEnv("PI_SUBAGENT_SELF_RECORD_ID", "rec-seam-1");
    vi.stubEnv("PI_SUBAGENT_AGENT", "fixer");
    vi.stubEnv("PI_SUBAGENT_MODE", "background");
    vi.stubEnv("PI_SUBAGENT_TASK", "do stuff");
    vi.stubEnv("PI_SUBAGENT_WORKTREE", "true");
    const { pi, entries } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx(), {});

    const identityEntry = entries.find((e) => e.customType === IDENTITY_CUSTOM_TYPE);
    expect(identityEntry).toBeDefined();
    expect(identityEntry!.data).toMatchObject({
      id: "rec-seam-1",
      agent: "fixer",
      mode: "background",
      task: "do stuff",
      worktree: true,
      chatMode: false,
    });
  });

  it("主进程（无 PI_SUBAGENT_SELF_RECORD_ID）不写 identity custom entry", async () => {
    const { pi, entries } = createFakePi();

    await setupSessionLifecycle(pi, createFakeCtx(), {});

    expect(entries.find((e) => e.customType === IDENTITY_CUSTOM_TYPE)).toBeUndefined();
  });
});

// ── 组 2：守卫合一（两消费点单一出口，u-4 行为变更点） ──────────────────────────

describe("getWorkflowDeps 守卫合一 — 两消费点同源同消息", () => {
  /** 挂载 index.ts 并跑一次 session_start（loadAll 行为可配），返回守卫观察面。 */
  async function mountWithLoadAll(loadAll: () => Promise<WorkflowRunType[]>): Promise<{
    pi: ExtensionAPI;
    lazyDeps: { store: unknown };
    workflowRun: (n: string, a: Record<string, unknown>) => Promise<{ status: string; reason: string; error?: string; runId: string }>;
  }> {
    mockStoreLoadAll.mockImplementation(loadAll);
    let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const noop = (): void => { /* fake */ };
    const pi = {
      appendEntry: noop,
      events: { emit: noop },
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        if (event === "session_start") {
          sessionStartHandler = handler as (event: unknown, ctx: unknown) => Promise<void>;
        }
      },
      sendMessage: noop,
      registerMessageRenderer: noop,
    } as unknown as ExtensionAPI;

    subagentsExtension(pi);

    const handler = sessionStartHandler!;
    await handler({ type: "session_start" }, createFakeCtx("session-guard-1"));

    // registerWorkflowTool 第二参 = lazyDeps（LauncherDeps getter 形态，u-5b 领地改写）
    const lazyDeps = mockRegisterWorkflowTool.mock.calls[0]?.[1] as { store: unknown };
    const workflowRun = (pi as unknown as {
      __workflowRun: (n: string, a: Record<string, unknown>) => Promise<{ status: string; reason: string; error?: string; runId: string }>;
    }).__workflowRun.bind(pi);
    return { pi, lazyDeps, workflowRun };
  }

  it("session 未初始化：tool 侧消费点（lazyDeps getter）throw 'Session not initialized'", async () => {
    // 新 factory 实例，不触发 session_start——sessionState 为空。
    const noop = (): void => { /* fake */ };
    const rawPi = {
      appendEntry: noop,
      events: { emit: noop },
      on: noop,
      sendMessage: noop,
      registerMessageRenderer: noop,
    } as unknown as ExtensionAPI;
    subagentsExtension(rawPi);
    const rawLazyDeps = mockRegisterWorkflowTool.mock.calls[mockRegisterWorkflowTool.mock.calls.length - 1]?.[1] as { store: unknown };

    expect(() => rawLazyDeps.store).toThrowError("Session not initialized");
  });

  it("store 不健康：__workflowRun 消费点返回错误对象（fail-fast，不 throw）", async () => {
    const { workflowRun } = await mountWithLoadAll(async () => {
      throw new Error("disk corruption");
    });

    const result = await workflowRun("any", {});

    expect(result.status).toBe("done");
    expect(result.reason).toBe("failed");
    expect(result.error).toContain("store unavailable");
    expect(result.error).toContain("loadAll failed");
  });

  it("store 不健康：两消费点从单一守卫出口拿到逐字相同的消息", async () => {
    const { lazyDeps, workflowRun } = await mountWithLoadAll(async () => {
      throw new Error("disk corruption");
    });

    const apiResult = await workflowRun("any", {});
    let toolSideMessage = "";
    try {
      void lazyDeps.store;
    } catch (err) {
      toolSideMessage = err instanceof Error ? err.message : String(err);
    }

    expect(toolSideMessage).not.toBe("");
    expect(toolSideMessage).toBe(apiResult.error);
  });
});
