// src/execution/__tests__/index-session-start.test.ts
//
// C2 critical: index.ts session_start 的 UI handler 注入链路测试。
//
// 测试目标：验证 `subagentsWorkflowExtension(pi)` 的 session_start handler
// 是否正确注入 uiRequestHandler，特别是 **SR-3**：
//   无论 new 还是 existing SubagentService，session_start 都必须调
//   setUiRequestHandler——/resume /fork 复用 existingService 时旧 handler 可能失效。
//
// 4 个 case：
//   1. new 路径（existingService=null）：setUiRequestHandler 被调，参数是函数（tui mode）
//   2. existing 路径（existingService=mockService）：setUiRequestHandler 仍被调（SR-3 关键）
//   3. headless mode（json）：createUiRequestHandlerForMode 返回 undefined，
//      setUiRequestHandler(undefined) 被调（不注入但仍有调用，SR-3 形式不破）
//   4. rpc mode：setUiRequestHandler 被调，参数是函数
//
// 既有 crash-recovery.test.ts / session-start-reaper.test.ts mock 了 SubagentService
// 但**没有断言 setUiRequestHandler 被调用**——本测试补这个断言，且覆盖 existing 路径
// （既有测试 fixed getSubagentService() => null，只能走 new 分支）。

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules（在 import 前声明；路径相对 src/execution/__tests/） ──
//
// [D15] 为何此处内联 vi.mock 与 vitest.config.ts 的 alias（包根 mocks/pi-coding-agent.ts）并存：
// 两套 mock 分工不同，不强制统一——
//   1. **config alias（包根 mocks/pi-coding-agent.ts）**：完整 stub，导出 ExtensionAPI/
//      ExtensionContext/ExtensionMode 等 *类型*（编译期擦除）+ getAgentDir 运行时值。服务于
//      全仓库绝大多数测试的类型解析与轻量 mock（不 import 真实重模块的测试直接吃 alias）。
//   2. **本文件内联 vi.mock（下方）**：vi.mock 在运行时覆盖 config alias，确保本文件 import
//      真实 index.ts（它 `import { getAgentDir } from "@earendil-works/pi-coding-agent"` +
//      一组 type-only import）时，运行时只暴露 getAgentDir，彻底隔离真实 SDK 的模块顶层
//      副作用（避免 jiti 加载真实 pi 包触发未 mock 的依赖链）。
//   3. 形状一致性：内联 mock 的运行时值形状（`{ getAgentDir }`）与 alias stub 的运行时值
//      形状完全一致（alias stub 运行时也只导出 getAgentDir 函数，类型导出在运行期擦除）。
//      差异仅在「覆盖时机」——vi.mock 比 alias 更早介入模块图解析，保证真实 index.ts 加载时
//      拿到的是纯函数桩而非 alias 的完整对象。
//   4. crash-recovery.test.ts / session-start-reaper.test.ts 同此模式（import 真实模块的
//      测试统一用内联 vi.mock 覆盖），三者保持一致。
// 结论：不抽共享 mocks 文件。alias 已承担类型解析，内联 vi.mock 承担运行时隔离，职责正交。

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/user/.pi/agent",
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/user/.pi/agent",
}));
vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: string[]) => ({ type: "string", enum: values }),
}));
vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: (values: string[]) => ({ type: "string", enum: values }),
}));
vi.mock("typebox", () => ({
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    Optional: (schema: unknown) => ({ ...(schema as object), optional: true }),
    String: () => ({ type: "string" }),
    Boolean: () => ({ type: "boolean" }),
    Number: () => ({ type: "number" }),
    Array: (items: unknown) => ({ type: "array", items }),
    Record: (key: unknown, value: unknown) => ({ type: "object", additionalProperties: value, key }),
    Unknown: () => ({ type: "unknown" }),
    Union: (members: unknown[]) => ({ type: "union", members }),
    Literal: (value: unknown) => ({ type: "literal", value }),
  },
}));

// ── hoisted mock 实例：捕获 setUiRequestHandler 调用 + 可控行为 ──

const {
  mockSetUiRequestHandler,
  mockInitSession,
  mockLoadAll,
  mockRecoverManifestTmpFiles,
  /** existing service 引用——测试可改写以模拟 /resume /fork 复用。 */
  existingServiceRef,
} = vi.hoisted(() => ({
  mockSetUiRequestHandler: vi.fn(),
  mockInitSession: vi.fn(),
  mockLoadAll: vi.fn(async () => []),
  // ADR-035 启动恢复接线守护：session_start 必须调 service.recoverManifestTmpFiles
  mockRecoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
  existingServiceRef: { current: null as unknown },
}));

// SubagentService mock：每次构造都返回同一组 spy，setUiRequestHandler 可观察。
// getSubagentService 返回 existingServiceRef.current（null=走 new；非 null=走 existing）。
vi.mock("../subagent-service.ts", () => ({
  SubagentService: class {
    initSession = mockInitSession;
    setUiRequestHandler = mockSetUiRequestHandler;
    recoverManifestTmpFiles = mockRecoverManifestTmpFiles;
    startGcTimer = vi.fn();
    getStreamSink = () => null;
    dispose = vi.fn();
  },
  getSubagentService: () => existingServiceRef.current,
  setSubagentService: vi.fn(),
}));

vi.mock("../model-config-service.ts", () => ({
  ModelConfigService: class {
    initModel = vi.fn();
    setCtxModel = vi.fn();
  },
  getModelConfigService: () => null,
  setModelConfigService: vi.fn(),
}));

vi.mock("../worktree-manager.ts", () => ({
  WorktreeManager: class {
    constructor(_agentDir: string) {
      /* mock */
    }
    scan = vi.fn();
    cleanup = vi.fn();
    create = vi.fn();
    collectPatch = vi.fn();
    registerPid = vi.fn();
  },
}));

vi.mock("../session-file-gc.ts", () => ({
  maybeCleanupExpiredSessionFiles: vi.fn(),
}));

// JsonlRunStore mock：loadAll 默认空数组（session_start 后段不抛即可）。
// dispose/flushPendingSaves：session_shutdown handler 会调 state.store.dispose()（W2C5）；
// dispose 用 hoisted spy 以便 W2TC16 断言（instance.dispose 即 spy）。
const { mockStoreDispose, mockStoreFlushPendingSaves } = vi.hoisted(() => ({
  mockStoreDispose: vi.fn(async () => {}),
  mockStoreFlushPendingSaves: vi.fn(async () => {}),
}));
vi.mock("../../orchestration/jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockLoadAll;
    save = vi.fn(async () => {});
    dispose = mockStoreDispose;
    flushPendingSaves = mockStoreFlushPendingSaves;
  },
}));

// lifecycle mock：仅替换 terminateRunningRuns 为 hoisted spy（W2TC16 断言
// terminate→dispose 顺序用），其余导出（scheduleTimeBudget/runWorkflow/abortRun/
// evictDoneRunsBeyondCap）经 importOriginal 保留真实实现——本文件不执行真实
// workflow，替换只影响 shutdown handler 的 terminate 调用点。
const { mockTerminateRunningRuns } = vi.hoisted(() => ({
  mockTerminateRunningRuns: vi.fn(async () => {}),
}));
vi.mock("../../orchestration/lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../orchestration/lifecycle.ts")>();
  return { ...actual, terminateRunningRuns: mockTerminateRunningRuns };
});

// interface 层 mock：避免触发真实 pi.registerTool（pi 是 Proxy，真实模块访问 pi
// 属性时可能抛错）。路径相对 src/execution/__tests/ → ../../interface/...
// registerWorkflowTool / registerWorkflowsCommand 用 hoisted spy——W3TC7/8 需在
// it 内读 mock.calls 捕获 lazyDeps 与 runs getter（对齐 mockStoreDispose 先例）。
vi.mock("../../interface/subagent-tool.ts", () => ({
  registerSubagentTool: vi.fn(),
}));
vi.mock("../../interface/subagents.ts", () => ({
  registerSubagentsCommand: vi.fn(),
}));
vi.mock("../../interface/bg-notify-render.ts", () => ({
  renderBgNotifyMessage: vi.fn(),
}));
const { mockRegisterWorkflowTool, mockRegisterWorkflowsCommand } = vi.hoisted(() => ({
  mockRegisterWorkflowTool: vi.fn(),
  mockRegisterWorkflowsCommand: vi.fn(),
}));
vi.mock("../../interface/tool-workflow.ts", () => ({
  registerWorkflowTool: mockRegisterWorkflowTool,
}));
vi.mock("../../interface/tool-workflow-script.ts", () => ({
  registerWorkflowScriptTool: vi.fn(),
}));
vi.mock("../../interface/commands.ts", () => ({
  registerWorkflowsCommand: mockRegisterWorkflowsCommand,
}));

// ── import 被测工厂 ──
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import subagentsExtension from "../../index.ts";
import { Budget } from "../../orchestration/models/budget.ts";
import { Trace } from "../../orchestration/models/trace.ts";
import { WorkflowRun } from "../../orchestration/models/workflow-run.ts";

// ── helpers ──

/** 创建可观察的 mock ExtensionAPI，捕获 session_start / session_shutdown handler。
 *  Proxy 兜底：未显式处理的 pi.xxx 返回 noop，避免抛错。 */
function createMockPi(): {
  pi: ExtensionAPI;
  getSessionStartHandler: () => ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  getSessionShutdownHandler: () => ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
} {
  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let sessionShutdownHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const events = { emit: vi.fn() };
  const noop = (): void => {
    /* mock */
  };
  const pi = new Proxy<ExtensionAPI>({} as ExtensionAPI, {
    get(_target, prop: string | symbol): unknown {
      if (prop === "on") {
        return (event: string, handler: (...args: unknown[]) => unknown) => {
          if (event === "session_start") {
            sessionStartHandler = handler as (event: unknown, ctx: unknown) => Promise<void>;
          }
          if (event === "session_shutdown") {
            sessionShutdownHandler = handler as (event: unknown, ctx: unknown) => Promise<void>;
          }
        };
      }
      if (prop === "events") return events;
      if (prop === "appendEntry") return noop;
      if (prop === "registerMessageRenderer") return noop;
      return noop;
    },
  });
  return {
    pi,
    getSessionStartHandler: () => sessionStartHandler,
    getSessionShutdownHandler: () => sessionShutdownHandler,
  };
}

/** 最小 ExtensionContext mock。mode 由参数控制（决定 handler 注入行为）。 */
function createMockCtx(mode: "tui" | "rpc" | "json" | "print"): Record<string, unknown> {
  const sessionManager = {
    getSessionId: () => "session-inject-1",
    getSessionFile: () => "/home/user/.pi/agent/sessions/session-inject-1.jsonl",
    getSessionDir: () => "/home/user/.pi/agent/sessions",
    getCwd: () => "/home/user/project",
    getEntries: () => [],
    getBranch: () => [],
    getLeafId: () => null,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getHeader: () => null,
    getTree: () => [],
    getSessionName: () => undefined,
  };
  const ui = mode === "rpc" ? { setWidget: vi.fn() } : undefined;
  return {
    cwd: "/home/user/project",
    mode,
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
    model: undefined,
    sessionManager,
    ui,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadAll.mockResolvedValue([]);
  existingServiceRef.current = null;
});

// ── tests ──

describe("session_start UI handler 注入链路（SR-3）", () => {
  it("new 路径（existingService=null）：setUiRequestHandler 被调，参数是函数（tui mode）", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // SR-3 核心：setUiRequestHandler 必须被调
    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
    // 非 headless mode → 注入的是函数（UiRequestHandler），非 undefined
    const injected = mockSetUiRequestHandler.mock.calls[0]?.[0];
    expect(typeof injected).toBe("function");
  });

  it("existing 路径（existingService=mockService）：setUiRequestHandler 仍被调（SR-3 关键）", async () => {
    // 模拟 /resume /fork：getSubagentService() 返回已存在的 service
    //（同一 mock 类的实例——spy 仍是 mockSetUiRequestHandler，断言可观察到调用）
    existingServiceRef.current = {
      initSession: mockInitSession,
      setUiRequestHandler: mockSetUiRequestHandler,
      // ADR-035：与 SubagentService mock class 形状一致——session_start
      // 会调 service.recoverManifestTmpFiles()，缺方法会抛 TypeError 被吞为 console.warn
      recoverManifestTmpFiles: mockRecoverManifestTmpFiles,
      startGcTimer: vi.fn(),
      getStreamSink: () => null,
      dispose: vi.fn(),
    };

    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // SR-3 关键断言：existing 路径下 setUiRequestHandler 仍被调
    //（旧 handler 可能已失效，session_start 必须重新注入）
    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
    const injected = mockSetUiRequestHandler.mock.calls[0]?.[0];
    expect(typeof injected).toBe("function");

    // ADR-035 existing 路径守护：/resume /fork 复用 service 时 session_start
    // 也必须调 recoverManifestTmpFiles。守护 case 走 new 路径抓不到 existing 误删，
    // 此处对称断言（与 setUiRequestHandler 在本 case 的独立断言同模式）。
    expect(mockRecoverManifestTmpFiles).toHaveBeenCalledTimes(1);
  });

  it("headless mode（json）：createUiRequestHandlerForMode 返回 undefined → setUiRequestHandler(undefined)", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx("json"));

    // SR-3 形式不破：仍调 setUiRequestHandler（参数是 undefined，表示不注入）
    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
    expect(mockSetUiRequestHandler.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("rpc mode：setUiRequestHandler 被调，参数是函数", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx("rpc"));

    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
    const injected = mockSetUiRequestHandler.mock.calls[0]?.[0];
    expect(typeof injected).toBe("function");
  });

  it("initSession 不再收 uiRequestHandler（#24 单一注入入口：setUiRequestHandler 唯一通道）", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // [#24] uiRequestHandler 单一注入入口：index.ts 只调 service.setUiRequestHandler(h)，
    // 不再重复传 initSession.uiRequestHandler——避免同一 handler 双路径注入造成
    // "哪一个是 source of truth" 歧义。此处断言该契约不被回退。
    expect(mockInitSession).toHaveBeenCalledTimes(1);
    const initArg = mockInitSession.mock.calls[0]?.[0] as {
      uiRequestHandler?: unknown;
      mode?: unknown;
      dialogQueue?: unknown;
    } | undefined;
    expect(initArg).toBeDefined();
    // uiRequestHandler 不再走 initSession（已被 #24 移除）
    expect(initArg?.uiRequestHandler).toBeUndefined();
    // mode 仍需 session 级注入（uiObservability.setMode 依赖它）
    expect(initArg?.mode).toBe("tui");
    // dialogQueue 仍注入（SR-4 清理路径接通）
    expect(initArg).toHaveProperty("dialogQueue");
    // handler 经 setUiRequestHandler 注入（单一入口）——前面 case 已断言，此处复断不再赘述。
    expect(mockSetUiRequestHandler).toHaveBeenCalledTimes(1);
  });

  it("session_start 调用 recoverManifestTmpFiles（接线守护，防 ADR-035 启动恢复再次断线）", async () => {
    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // ADR-035 接线断言：session_start 必须调 service.recoverManifestTmpFiles（防死代码回退）
    expect(mockRecoverManifestTmpFiles).toHaveBeenCalledTimes(1);
  });
});

describe("session_shutdown: store.dispose 接线（W2TC16）", () => {
  it("W2TC16: session_shutdown 触发后 store 实例 dispose 被调用（terminate 完成之后、sessionState 清理之前）", async () => {
    // 预热：session_start 建立一个 sessionState 条目（含 mock store 实例）。
    // loadAll 注入 running run 使其进入 sessionState.runs——duck-typed 对象 +
    // no-op transition：session_start 的 kill-9 恢复会把 running run 转 done,failed
    // （真实 WorkflowRun.reconstruct 无法保持 running），no-op transition 吞掉该转换
    // 让 run 以 running 进入 sessionState.runs。运行时形状由消费路径保证：handler
    // 只读 state.status（string）与 transition（可调用），duck typing 满足。
    mockStoreDispose.mockClear();
    const runningRun = {
      runId: "wf-w2tc16-1",
      state: { status: "running", error: undefined as string | undefined },
      transition: vi.fn(),
    } as unknown as WorkflowRun;
    mockLoadAll.mockResolvedValue([runningRun]);
    const { pi, getSessionStartHandler, getSessionShutdownHandler } = createMockPi();
    subagentsExtension(pi);

    const startHandler = getSessionStartHandler();
    expect(startHandler).toBeDefined();
    await startHandler!({ type: "session_start" }, createMockCtx("tui"));

    // terminate gate：deferred 模拟 terminateRunningRuns 内部 `await store.save(run)`
    // 落盘边界——resolve 前 dispose 不得发生（terminate 未完成 = failed 状态未落盘，
    // 此刻 dispose 刷 pending 批会把未定稿的 running 尾巴刷出去，重启后 kill-9
    // 恢复误判）。
    let resolveTerminate = (): void => {};
    mockTerminateRunningRuns.mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        resolveTerminate = r;
      });
    });

    // 触发 session_shutdown（event 触发模式对齐本文件 session_start 既有写法）
    const shutdownHandler = getSessionShutdownHandler();
    expect(shutdownHandler).toBeDefined();
    const shutdownDone = shutdownHandler!({ type: "session_shutdown" }, createMockCtx("tui"));

    // terminate 未完成（save 未落盘）→ dispose 未被调（await 边界真实生效）
    await Promise.resolve();
    expect(mockStoreDispose).not.toHaveBeenCalled();

    resolveTerminate();
    await shutdownDone;

    // 每 sessionState 条目一次：session_start 建了 1 个 session → terminate 调用 1 次
    expect(mockTerminateRunningRuns).toHaveBeenCalledTimes(1);
    // 原因串字面值（session_shutdown 路径，接口契约锁定）
    expect(mockTerminateRunningRuns.mock.calls[0]?.[1]).toBe("Session shutdown: run terminated");
    // dispose 在 terminate 完成后被调（每 session 1 次）
    expect(mockStoreDispose).toHaveBeenCalledTimes(1);

    // 顺序断言「sessionState 清理之前」（标题后半）：sessionState.delete 是 Map
    // 同步操作、无外部可观察 spy——用第二次 shutdown 的幂等性间接证明：第一次
    // handler 内条目已删（delete 在 dispose await 之后执行），重复 shutdown 遍历
    // 空 Map 不再二次 terminate/dispose。若清理被跳过，此处会涨到 2 次。
    await shutdownHandler!({ type: "session_shutdown" }, createMockCtx("tui"));
    expect(mockTerminateRunningRuns).toHaveBeenCalledTimes(1);
    expect(mockStoreDispose).toHaveBeenCalledTimes(1);
  });
});

// ── W-N: done run 淘汰接线（loadAll 裁剪 + onRunDone 裁剪） ──

/** fixture 基准时刻（过去时刻，保证 now 恒晚于全部 fixture completedAt）。 */
const W3_T0 = Date.parse("2020-01-01T00:00:00.000Z");
function w3IsoAt(min: number): string {
  return new Date(W3_T0 + min * 60_000).toISOString();
}

/** loadAll 重水合输入 fixture：done run（status done reason completed + completedAt）。 */
function makeLoadedDoneRun(runId: string, completedAt: string): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "execute() {}",
      args: {},
      scriptName: "test",
      scriptPath: "/fake/test.js",
    },
    {
      status: "done",
      reason: "completed",
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: completedAt, completedAt },
  );
}

/** loadAll 重水合输入 fixture：running run（kill-9 恢复输入，reconstruct 跳 I1 合法）。 */
function makeLoadedRunningRun(runId: string): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    {
      scriptSource: "execute() {}",
      args: {},
      scriptName: "test",
      scriptPath: "/fake/test.js",
    },
    {
      status: "running",
      budget: new Budget({ maxTokens: 1000 }),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: w3IsoAt(0) },
  );
}

describe("W-3: done run 淘汰接线（loadAll 裁剪 + onRunDone 裁剪）", () => {
  it("W3TC7: session_start loadAll 灌入后裁剪到 K（21 done + 1 running kill-9 恢复）", async () => {
    // 21 个 done（completedAt 递增）+ 1 个 running（kill-9 恢复输入）
    const doneRuns = Array.from({ length: 21 }, (_, i) =>
      makeLoadedDoneRun(`wf-loaded-${i}`, w3IsoAt(i)));
    const runningRun = makeLoadedRunningRun("wf-recovered-1");
    mockLoadAll.mockResolvedValue([...doneRuns, runningRun]);

    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);
    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // runs Map 观察点 = registerWorkflowsCommand 第二参数的 runs getter
    //（工厂入口同步调用，mock.calls[0] 恒存在）
    const getRuns = mockRegisterWorkflowsCommand.mock.calls[0]?.[1] as
      | (() => Map<string, WorkflowRun>)
      | undefined;
    expect(typeof getRuns).toBe("function");
    const runs = getRuns!();

    // kill-9 恢复链把 running 转 done,failed（既有语义）后共 22 done → 裁到 20
    expect(runs.size).toBe(20);
    // 恢复 run 的 completedAt 为 transition 时刻（now，晚于全部 fixture 过去时间戳）
    // → 必在保留端
    expect(runs.has("wf-recovered-1")).toBe(true);
    expect(runs.get("wf-recovered-1")?.state.status).toBe("done");
    expect(runs.get("wf-recovered-1")?.state.reason).toBe("failed");
    // 被淘汰 2 个 = fixture 最旧两个
    expect(runs.has("wf-loaded-0")).toBe(false);
    expect(runs.has("wf-loaded-1")).toBe(false);
    for (let i = 2; i < 21; i++) {
      expect(runs.has(`wf-loaded-${i}`)).toBe(true);
    }
  });

  it("W3TC8: onRunDone 回调接线——notify → track → evict，本轮 run 不被自身触发的裁剪淘汰", async () => {
    // session_start 预热：恰好 20 个 done（completedAt t0..t19）
    const doneRuns = Array.from({ length: 20 }, (_, i) =>
      makeLoadedDoneRun(`wf-pre-${i}`, w3IsoAt(i)));
    mockLoadAll.mockResolvedValue(doneRuns);

    const { pi, getSessionStartHandler } = createMockPi();
    subagentsExtension(pi);
    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx("tui"));

    // lazyDeps = registerWorkflowTool 第二参数（getter 转发 makeDeps 的 onRunDone）
    const lazyDeps = mockRegisterWorkflowTool.mock.calls[0]?.[1] as
      | { onRunDone: (run: WorkflowRun) => void }
      | undefined;
    expect(lazyDeps).toBeDefined();

    // 本轮 newDoneRun：completedAt = now（晚于全部 fixture 过去时间戳）
    const newDoneRun = WorkflowRun.reconstruct(
      "wf-current-1",
      {
        scriptSource: "execute() {}",
        args: {},
        scriptName: "test",
        scriptPath: "/fake/test.js",
      },
      {
        status: "done",
        reason: "completed",
        budget: new Budget({ maxTokens: 1000 }),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: w3IsoAt(999), completedAt: new Date().toISOString() },
    );

    // 模拟真实流程的注册步骤：lifecycle.ts runWorkflow 在创建时 deps.runs.set(runId, run)
    //（onRunDone 回调只裁剪不注册——本轮 run 必须先在 Map 中，「保留端」断言才有对象）
    const getRuns = mockRegisterWorkflowsCommand.mock.calls[0]?.[1] as
      | (() => Map<string, WorkflowRun>)
      | undefined;
    expect(typeof getRuns).toBe("function");
    const runs = getRuns!();
    runs.set("wf-current-1", newDoneRun);

    // 回调不抛错（notifyDone 对 mock pi Proxy 安全：sendMessage 返回 noop；
    // toGuiCtx(tui ctx) isGuiCapable false 走无 __gui__ 分支）
    expect(() => lazyDeps!.onRunDone(newDoneRun)).not.toThrow();

    // 21 done 裁 1：size 回到 20
    expect(runs.size).toBe(20);
    // 被淘汰的是 t0 最旧 run 而非本轮 run（completedAt 最新恒在保留端）
    expect(runs.has("wf-current-1")).toBe(true);
    expect(runs.has("wf-pre-0")).toBe(false);
    for (let i = 1; i < 20; i++) {
      expect(runs.has(`wf-pre-${i}`)).toBe(true);
    }
  });
});
