// src/execution/__tests__/index-session-start-identity.test.ts
//
// [M4 / V2 决策 5] identity 子进程写入测试。
//
// 验证 index.ts session_start hook 的 identity 写入职责：
//   1. 子进程（PI_SUBAGENT_SELF_RECORD_ID 存在）：调 pi.appendEntry 写
//      customType="subagent-identity" 的 custom entry，data 字段与 env 组装的
//      SubagentIdentityData 一致（id/agent/mode/task/slug/startedAt/rootSessionId/
//      parentRecordId/depth/forkDepth/chatMode）。
//   2. 主进程（无 PI_SUBAGENT_SELF_RECORD_ID）：不写 identity custom entry。
//   3. 可选字段缺失（chatMode/slug/parentRecordId/forkDepth 未注入）：identity 仍写入，
//      可选字段为 undefined / false，不抛错。
//
// 修复背景：旧实现父进程 fs.appendFileSync 补写的 custom entry 缺 id/parentId →
// 污染 pi _buildIndex leafId → message tree 断成两棵 → 多轮对话丢上下文。
// 改由子进程（session 文件所有者）在 session_start 用 pi.appendEntry 写，
// pi 自动生成 id/parentId → message tree 连续。
//
// mock 模式复用 index-session-start.test.ts（隔离真实 SDK 顶层副作用），差异：
// appendEntry 改 vi.fn() 捕获调用（断言 identity custom entry）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules（路径相对 src/execution/__tests/）──
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/user/.pi/agent",
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

// ── hoisted mock 实例 ──
const { mockSetUiRequestHandler, mockInitSession, mockLoadAll, mockRecoverManifestTmpFiles } =
  vi.hoisted(() => ({
    mockSetUiRequestHandler: vi.fn(),
    mockInitSession: vi.fn(),
    mockLoadAll: vi.fn(async () => []),
    mockRecoverManifestTmpFiles: vi.fn(async () => ({ deleted: 0, recovered: 0 })),
  }));

vi.mock("../subagent-service.ts", () => ({
  SubagentService: class {
    initSession = mockInitSession;
    setUiRequestHandler = mockSetUiRequestHandler;
    recoverManifestTmpFiles = mockRecoverManifestTmpFiles;
    getStreamSink = () => null;
    dispose = vi.fn();
  },
  getSubagentService: () => null,
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

vi.mock("../../orchestration/jsonl-run-store.ts", () => ({
  JsonlRunStore: class {
    loadAll = mockLoadAll;
    save = vi.fn(async () => {});
  },
}));

vi.mock("../../interface/subagent-tool.ts", () => ({ registerSubagentTool: vi.fn() }));
vi.mock("../../interface/subagents.ts", () => ({ registerSubagentsCommand: vi.fn() }));
vi.mock("../../interface/bg-notify-render.ts", () => ({ renderBgNotifyMessage: vi.fn() }));
vi.mock("../../interface/tool-workflow.ts", () => ({ registerWorkflowTool: vi.fn() }));
vi.mock("../../interface/tool-workflow-script.ts", () => ({
  registerWorkflowScriptTool: vi.fn(),
}));
vi.mock("../../interface/commands.ts", () => ({ registerWorkflowsCommand: vi.fn() }));

// ── import 被测工厂 ──
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import subagentsExtension from "../../index.ts";
import { IDENTITY_CUSTOM_TYPE } from "../session-reconstructor.ts";

// ── helpers ──

const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_MODE",
  "PI_SUBAGENT_TASK",
  "PI_SUBAGENT_SLUG",
  "PI_SUBAGENT_STARTED_AT",
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_PARENT_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_FORK_DEPTH",
  "PI_SUBAGENT_CHAT_MODE",
] as const;

function clearIdentityEnv(): void {
  for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
}

/** 创建可观察 appendEntry 的 mock ExtensionAPI，捕获 session_start handler。 */
function createMockPi(): {
  pi: ExtensionAPI;
  getSessionStartHandler: () => ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  appendEntrySpy: ReturnType<typeof vi.fn>;
} {
  let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const appendEntrySpy = vi.fn();
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
        };
      }
      if (prop === "events") return events;
      if (prop === "appendEntry") return appendEntrySpy;
      if (prop === "registerMessageRenderer") return noop;
      return noop;
    },
  });
  return { pi, getSessionStartHandler: () => sessionStartHandler, appendEntrySpy };
}

/** 最小 ExtensionContext mock（tui mode，足够走完 session_start 装配）。 */
function createMockCtx(): Record<string, unknown> {
  const sessionManager = {
    getSessionId: () => "session-identity-1",
    getSessionFile: () => "/home/user/.pi/agent/sessions/session-identity-1.jsonl",
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
  return {
    cwd: "/home/user/project",
    mode: "tui",
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
    model: undefined,
    sessionManager,
    ui: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadAll.mockResolvedValue([]);
  clearIdentityEnv();
});

afterEach(() => {
  clearIdentityEnv();
});

// ── tests ──

describe("session_start identity 子进程写入（M4 / V2 决策 5）", () => {
  it("子进程（PI_SUBAGENT_SELF_RECORD_ID 存在）：appendEntry 写完整 identity custom entry", async () => {
    process.env.PI_SUBAGENT_SELF_RECORD_ID = "rec-child-1";
    process.env.PI_SUBAGENT_AGENT = "worker";
    process.env.PI_SUBAGENT_MODE = "background";
    process.env.PI_SUBAGENT_TASK = "fix the bug";
    process.env.PI_SUBAGENT_SLUG = "fix-bug";
    process.env.PI_SUBAGENT_STARTED_AT = "1700000000000";
    process.env.PI_SUBAGENT_ROOT_SESSION_ID = "root-session-9";
    process.env.PI_SUBAGENT_PARENT_RECORD_ID = "rec-parent-0";
    process.env.PI_SUBAGENT_DEPTH = "2";
    process.env.PI_SUBAGENT_FORK_DEPTH = "1";
    process.env.PI_SUBAGENT_CHAT_MODE = "true";

    const { pi, getSessionStartHandler, appendEntrySpy } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx());

    // 找到 identity 的 appendEntry 调用（customType = IDENTITY_CUSTOM_TYPE）
    const identityCall = appendEntrySpy.mock.calls.find(
      (c: unknown[]) => c[0] === IDENTITY_CUSTOM_TYPE,
    );
    expect(identityCall).toBeDefined();
    // customType 第一参数
    expect(identityCall![0]).toBe(IDENTITY_CUSTOM_TYPE);
    // data 第二参数：与 env 组装的 SubagentIdentityData 一致
    const data = identityCall![1] as Record<string, unknown>;
    expect(data).toMatchObject({
      id: "rec-child-1",
      agent: "worker",
      mode: "background",
      task: "fix the bug",
      slug: "fix-bug",
      startedAt: 1700000000000,
      rootSessionId: "root-session-9",
      parentRecordId: "rec-parent-0",
      depth: 2,
      forkDepth: 1,
      chatMode: true,
    });
  });

  it("主进程（无 PI_SUBAGENT_SELF_RECORD_ID）：不写 identity custom entry", async () => {
    // 不设 SELF_RECORD_ID（主进程环境）
    const { pi, getSessionStartHandler, appendEntrySpy } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    expect(handler).toBeDefined();
    await handler!({ type: "session_start" }, createMockCtx());

    // 无 identity 的 appendEntry 调用（logger.warn 等可能调 workflow:log，需过滤）
    const identityCall = appendEntrySpy.mock.calls.find(
      (c: unknown[]) => c[0] === IDENTITY_CUSTOM_TYPE,
    );
    expect(identityCall).toBeUndefined();
  });

  it("可选字段缺失（chatMode/slug/parentRecordId/forkDepth 未注入）：identity 仍写入，可选字段为默认", async () => {
    process.env.PI_SUBAGENT_SELF_RECORD_ID = "rec-child-2";
    process.env.PI_SUBAGENT_AGENT = "explorer";
    process.env.PI_SUBAGENT_MODE = "background";
    process.env.PI_SUBAGENT_TASK = "scan code";
    process.env.PI_SUBAGENT_STARTED_AT = "1700000000002";
    process.env.PI_SUBAGENT_ROOT_SESSION_ID = "root-9";
    process.env.PI_SUBAGENT_DEPTH = "1";
    // 不设 SLUG / PARENT_RECORD_ID / FORK_DEPTH / CHAT_MODE

    const { pi, getSessionStartHandler, appendEntrySpy } = createMockPi();
    subagentsExtension(pi);

    const handler = getSessionStartHandler();
    await handler!({ type: "session_start" }, createMockCtx());

    const identityCall = appendEntrySpy.mock.calls.find(
      (c: unknown[]) => c[0] === IDENTITY_CUSTOM_TYPE,
    );
    expect(identityCall).toBeDefined();
    const data = identityCall![1] as Record<string, unknown>;
    // 必填字段正常
    expect(data.id).toBe("rec-child-2");
    expect(data.agent).toBe("explorer");
    expect(data.mode).toBe("background");
    expect(data.startedAt).toBe(1700000000002);
    // 可选字段缺失 → undefined / false
    expect(data.chatMode).toBe(false);
    expect(data.slug).toBeUndefined();
    expect(data.parentRecordId).toBeUndefined();
    expect(data.forkDepth).toBeUndefined();
  });
});
