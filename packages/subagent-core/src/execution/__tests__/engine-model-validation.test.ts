// engine-model-validation.test.ts —— [u-h2] 引擎感知 model 校验单测。设计权威源：
// docs/design/timeout-audit-hygiene-batch.md §3.2（D2-1 路由先行 / D2-2 validateModel
// 可选面 / D2-3 场景 2/3 文案 / D2-4 跨引擎候选）+ §4.2 V2-1~V2-4 可单测部分 +
// §5.4 P2-1 时序回归（record/emit 顺序）单测锁定。
//
// 覆盖：
//   A. chat 路径 execute()：路由先行（zcode id + zcode 引擎不再被 pi registry 拒绝，
//      V2-1）+ pi id 用在 zcode 的派发同步期报错（V2-2，场景 2 文案逐句断言）+
//      frontmatter model 归趋（D2-1）+ ctxModel 不透传 + 未实现 validateModel 的
//      引擎透传兜底（现状语义）。
//   B. pi registry 未命中的跨引擎候选（V2-3 场景 3；唯一命中才提示；大小写错误 id
//      原文案零回归 V2-4③）。
//   C. workflow 路径 SAR：非 pi 校验调用点（V2-4②成功形态不回归 / V2-4④错误形态
//      同步期报错，不进 engine.run）。
//   D. P2-1 时序回归：pi 缺省路径 record entry → pending:register 既有顺序锁定；
//      非 pi 校验失败零 record 零 emit。
//   E. zcode 引擎 validateModel 委托 resolveZcodeModelRef（真实 preparer + 临时 v2
//      config——同一函数两处消费，无重复实现）。
//
// mock 策略：node:child_process.spawn mock（pi 原路径不真 spawn）；非 pi 引擎用
// registry 注入的 fake EnginePort（validateModel/listModels 行为可注入）；v2 config
// 用真实临时文件（D 组）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureCore, resetCoreForTests } from "../../core/host-services.ts";

vi.mock("node:child_process", async () => {
  const { EventEmitter: EE } = await import("node:events");
  const { PassThrough: PT } = await import("node:stream");
  class FakeChild extends EE {
    pid = 12345;
    stdout = new PT();
    stderr = new PT();
    stdin = new PT();
    killed = false;
    kill(sig?: string): boolean {
      this.killed = true;
      return sig !== undefined;
    }
  }
  return {
    spawn: vi.fn(() => new FakeChild()),
    execFile: vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => cb(new Error("execFile not configured in this test")),
    ),
  };
});

import { spawn as spawnMock } from "node:child_process";

import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import type { EnginePort, RunContext } from "../engine/port.ts";
import { ZcodeEngine } from "../engine/engines/zcode/zcode-engine.ts";
import { ZcodePrepareError } from "../engine/engines/zcode/preparer.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type {
  AgentTaskSpec,
  EngineCapabilities,
  EngineHandle,
  ProbeReport,
} from "../engine/types.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import { SubagentService } from "../subagent-service.ts";
import { SubprocessAgentRunner } from "../subprocess-agent-runner.ts";
import type { SubagentService as SubagentServiceType } from "../subagent-service.ts";
import type { ExecuteOptions } from "../types.ts";

const mockSpawn = vi.mocked(spawnMock);

// ── 既有 pi registry 内容（pi id 空间）与 zcode id 空间（互不认识——设计 §2.2）──

const PI_ID = "pi-org/pi-main";
const CTX_MODEL: ModelInfo = { id: "pi-main", name: "PI Main", provider: "pi-org", reasoning: false };

const ZCODE_DEFAULT = "builtin:bigmodel-coding-plan/GLM-5.3";
const ZCODE_FLASH = "builtin:bigmodel-coding-plan/GLM-5.3-Flash";

// ============================================================
// fake 引擎（validateModel/listModels 行为可注入）
// ============================================================

const ZCODE_LIKE_CAPS: EngineCapabilities = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "prompt",
  eventGranularity: "coarse",
  sandbox: "none",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "native",
};

interface ValidatingEngineOpts {
  id: string;
  models: string[];
  /** validateModel 对非清单 id 抛出的错误（缺省按 model_not_available 形态）。 */
  validateModelError?: Error;
  /** false = 不实现 validateModel（透传兜底形态用例）。 */
  withValidateModel?: boolean;
}

class ValidatingFakeEngine implements EnginePort {
  readonly id: string;
  readonly models: string[];
  readonly runs: Array<{ task: AgentTaskSpec; ctx: RunContext }> = [];
  private readonly validateModelError: Error | undefined;
  private readonly withValidateModel: boolean;

  constructor(opts: ValidatingEngineOpts) {
    this.id = opts.id;
    this.models = opts.models;
    this.validateModelError = opts.validateModelError;
    this.withValidateModel = opts.withValidateModel !== false;
  }

  capabilities(): EngineCapabilities {
    return ZCODE_LIKE_CAPS;
  }
  async probe(): Promise<ProbeReport> {
    return { ok: true, engineVersion: "fake", checks: [{ name: "bin", ok: true }] };
  }
  async run(task: AgentTaskSpec, ctx: RunContext): Promise<{ handle: EngineHandle; outcome: { engineId: string; content: string } }> {
    this.runs.push({ task, ctx });
    return {
      handle: { data: { v: 1, engineId: this.id, sessionRef: {}, poolKey: "shared", adapterVersion: "test" } },
      outcome: { engineId: this.id, content: "ok" },
    };
  }
  async interact(): Promise<{ ok: false; code: string; message: string }> {
    return { ok: false, code: "engine_capability_unsupported", message: "fake" };
  }
  async read(): Promise<{ engineId: string; turns: never[]; source: "outcome-only" }> {
    return { engineId: this.id, turns: [], source: "outcome-only" };
  }

  listModels(): Array<{ id: string; name?: string }> {
    return this.models.map((id) => ({ id }));
  }

  validateModel(modelRef: string | undefined): { canonicalRef: string } {
    if (!this.withValidateModel) throw new Error("validateModel not implemented on this fake");
    if (this.validateModelError !== undefined) throw this.validateModelError;
    if (modelRef === undefined || modelRef.trim() === "") return { canonicalRef: this.models[0]! };
    if (this.models.includes(modelRef)) return { canonicalRef: modelRef };
    throw new Error(`[model_not_available] unknown model "${modelRef}" (fake registry)`);
  }
}

// ============================================================
// chat 路径装配（chat-engine-routing.test.ts 同款范式）
// ============================================================

function fakePiRegistry(): ModelRegistryLike {
  const AVAILABLE: ModelInfo[] = [CTX_MODEL];
  return {
    getAvailable: () => AVAILABLE,
    find: (provider: string, id: string) => AVAILABLE.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
  };
}

interface ChatSetup {
  service: SubagentService;
  zcode: ValidatingFakeEngine;
  pi: {
    sendMessage: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
    events: { emit: ReturnType<typeof vi.fn> };
  };
  /** 统一时间线（appendEntry 与 events.emit 的调用顺序——P2-1 断言用）。 */
  eventLog: string[];
}

function setupChat(agentDir: string, opts?: { defaultEngine?: string; extraEngine?: ValidatingFakeEngine }): ChatSetup {
  const zcode = new ValidatingFakeEngine({ id: "zcode", models: [ZCODE_DEFAULT, ZCODE_FLASH] });
  registerEngine("zcode", () => zcode);
  if (opts?.extraEngine !== undefined) registerEngine(opts.extraEngine.id, () => opts.extraEngine);
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: fakePiRegistry(),
    sessionId: "test-session",
    ctxModel: CTX_MODEL,
  });
  const eventLog: string[] = [];
  const appendEntry = vi.fn((type: string) => {
    eventLog.push(`entry:${type}`);
  });
  const emit = vi.fn((channel: string) => {
    eventLog.push(`emit:${channel}`);
  });
  const pi = { sendMessage: vi.fn(), appendEntry, events: { emit } };
  const service = new SubagentService({ cwd: agentDir, modelService });
  service.initSession({ pi, sessionId: "test-session" });
  return { service, zcode, pi, eventLog };
}

function writeGlobalConfig(agentDir: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(agentDir, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "subagents", "config.json"), JSON.stringify(cfg));
}

function writeAgentMd(dir: string, frontmatter: string): string {
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  const p = path.join(dir, "agents", "fm-agent.md");
  fs.writeFileSync(p, `---\n${frontmatter}\n---\nbody\n`);
  return p;
}

function baseOpts(agentDir: string, extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return { task: "do work", slug: "validation-test", cwd: agentDir, ctxModel: CTX_MODEL, ...extra };
}

/**
 * 等待 detached finalize 链完全静止后再离开用例（flake 加固 2026-09-05）。
 *
 * fake run 立即 resolve → kickOffEngineRun 的 detached 链推进 finalizeEngineOutcome →
 * finalizeRecord（内含 writeManifest——fs.promises 真异步，threadpool 落盘）→
 * notifyComplete → pi.sendMessage。sendMessage 被调 = runEngineTask 已 await 完成
 * = 链上全部异步落盘已 resolve（与 chat-engine-routing 终态通知同一等待语义）。
 *
 * 缺失本等待时，链的在途写盘会跨过 afterEach 的 fs.rmSync——threadpool 写与主线程
 * 删除目录树竞争，rmSync 以 ENOTEMPTY 失败打翻清理（单文件跑时间隙足够恒绿，
 * 全量并发负载下写延迟跨窗即偶发——本文件曾因此 6 轮中 2 轮失败）。
 */
async function settleEngineRunChain(pi: ChatSetup["pi"]): Promise<void> {
  await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());
}

describe("chat 路径：路由先行 + 按目标引擎校验 model（u-h2 V2-1/V2-2）", () => {
  let agentDir: string;

  beforeEach(() => {
    configureCore({ dataRoot: () => "/fake-model-validation-data-root", log: () => {} });
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-model-validation-"));
    writeGlobalConfig(agentDir, { version: 1, maxConcurrent: 6 });
  });

  afterEach(() => {
    clearEngines();
    resetCoreForTests();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.clearAllMocks();
  });

  // ── V2-1（原 F2-A）：zcode 合法模型不再被 pi registry 误导性拒绝 ──

  it("[V2-1a] defaultEngine=zcode 不传 engine + zcode id → 成功派发（修复前报 not a registry entry）", async () => {
    writeGlobalConfig(agentDir, { version: 1, maxConcurrent: 6, defaultEngine: "zcode" });
    const { service, zcode, pi } = setupChat(agentDir);

    const handle = await service.execute(baseOpts(agentDir, { model: ZCODE_FLASH }));
    // record 身份字段产生于 execute 同步段——resolve 后立即快照：fake run 立即 resolve，
    // 轮询窗口内 finalize/archive 会把 record 移出 running（waitFor 后再读是负载敏感竞态）
    const rec = service.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    expect(rec?.engine).toBe("zcode");
    expect(rec?.model).toBe(ZCODE_FLASH);
    // 引擎派发事实单独确定性等待（runs 数组只增不删）
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    expect(zcode.runs[0]!.task.model).toBe(ZCODE_FLASH);
    // 链静止后再离开用例（afterEach rmSync 竞争防御，见 helper 注释）
    await settleEngineRunChain(pi);
  });

  it("[V2-1b] 显式 engine='zcode' + zcode id → 成功派发", async () => {
    const { service, zcode, pi } = setupChat(agentDir);
    const handle = await service.execute(baseOpts(agentDir, { engine: "zcode", model: ZCODE_FLASH }));
    // 同步段快照（竞态依据同 V2-1a）
    const rec = service.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    expect(rec?.engine).toBe("zcode");
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    expect(zcode.runs[0]!.task.model).toBe(ZCODE_FLASH);
    await settleEngineRunChain(pi);
  });

  // ── V2-2（原 F2-B）：pi id 用在 zcode → 派发同步期明确报错（场景 2 文案逐句）──

  it("[V2-2] pi id 派发 zcode → 同步期 EngineModelMismatchError（registry 独立 + 清单 + 修正动作）", async () => {
    const { service, zcode } = setupChat(agentDir);

    const err = await service
      .execute(baseOpts(agentDir, { engine: "zcode", model: PI_ID }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("EngineModelMismatchError");
    expect((err as { code?: string }).code).toBe("model_not_available");
    const msg = (err as Error).message;
    // ① 点破引擎与模型不配套 + registry 独立
    expect(msg).toContain(`model '${PI_ID}' is not available on engine 'zcode'.`);
    expect(msg).toContain(
      "Engine registries are independent — ids in <available_provider_models> (pi registry) do NOT apply to 'zcode' dispatches.",
    );
    // ② 目标引擎可用清单（数据源 listModels，带凭据）
    expect(msg).toContain("zcode models with configured credentials:");
    expect(msg).toContain(ZCODE_DEFAULT);
    expect(msg).toContain(ZCODE_FLASH);
    // ③ 修正动作：清单重试 + 按引擎区分的省略语义（zcode 引擎缺省，非「继承主 agent」）
    expect(msg).toContain(
      `👉 Retry with one of the above (exact string), or omit \`model\` to use the 'zcode' engine default (${ZCODE_DEFAULT}).`,
    );
    expect(msg).not.toContain("inherit the main agent model");
    // recovery 字段（错误 → 权威源 → 重试闭环）
    expect((err as { recovery?: string }).recovery).toContain(`'zcode' engine default (${ZCODE_DEFAULT})`);
    // 同步期拒绝：零执行副作用
    expect(zcode.runs.length).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(service.collectRecords(10, "all")).toHaveLength(0);
  });

  // ── D2-1 逐层语义：frontmatter model / ctxModel / thinkingLevel ──

  it("[D2-1] frontmatter model（agent .md）+ engine: zcode → 原样透传给 taskSpec（作者声明不忽略）", async () => {
    const agentRef = writeAgentMd(agentDir, `name: fm-agent\ndescription: d\nengine: zcode\nmodel: ${ZCODE_FLASH}`);
    const { service, zcode, pi } = setupChat(agentDir);

    await service.execute(baseOpts(agentDir, { agent: agentRef }));
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    expect(zcode.runs[0]!.task.model).toBe(ZCODE_FLASH);
    await settleEngineRunChain(pi);
  });

  it("[D2-1] frontmatter model 配错（pi id + engine: zcode）→ 同步期场景 2 报错（不落引擎缺省静默续跑）", async () => {
    const agentRef = writeAgentMd(agentDir, `name: fm-agent\ndescription: d\nengine: zcode\nmodel: ${PI_ID}`);
    const { service, zcode } = setupChat(agentDir);

    const err = await service.execute(baseOpts(agentDir, { agent: agentRef })).catch((e: unknown) => e);
    expect((err as Error).message).toContain(`model '${PI_ID}' is not available on engine 'zcode'.`);
    expect(zcode.runs.length).toBe(0);
  });

  it("[D2-1] 无显式 model → ctxModel 不透传；validateModel(undefined) 裁决引擎缺省进 record", async () => {
    writeGlobalConfig(agentDir, { version: 1, maxConcurrent: 6, defaultEngine: "zcode" });
    const { service, zcode, pi } = setupChat(agentDir);

    const handle = await service.execute(baseOpts(agentDir));
    // 同步段快照 record 身份（竞态依据同 V2-1a）
    const rec = service.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    expect(rec?.model).toBe(ZCODE_DEFAULT);
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));

    // taskSpec.model 不带主 agent 的 pi id（引擎缺省语义归引擎）
    expect(zcode.runs[0]!.task.model).toBeUndefined();
    await settleEngineRunChain(pi);
  });

  it("[现状语义] 未实现 validateModel 的引擎 → model 原样透传（prepare 期兜底，零强制接入）", async () => {
    // plain object 构造（无 validateModel/listModels 成员——未来引擎未接入校验面的形态）
    const bare: EnginePort = {
      id: "bare",
      capabilities: () => ZCODE_LIKE_CAPS,
      probe: () => Promise.resolve({ ok: true, engineVersion: "bare", checks: [{ name: "bin", ok: true }] }),
      run: (task) => {
        bareRunTasks.push(task);
        return Promise.resolve({
          handle: { data: { v: 1, engineId: "bare", sessionRef: {}, poolKey: "shared", adapterVersion: "test" } },
          outcome: { engineId: "bare", content: "ok" },
        });
      },
      interact: () => Promise.resolve({ ok: false, code: "engine_capability_unsupported", message: "bare" }),
      read: () => Promise.resolve({ engineId: "bare", turns: [], source: "outcome-only" }),
    };
    const bareRunTasks: AgentTaskSpec[] = [];
    registerEngine("bare", () => bare);

    const { service, pi } = setupChat(agentDir);
    await service.execute(baseOpts(agentDir, { engine: "bare", model: "future-eng/future-model" }));
    await vi.waitFor(() => expect(bareRunTasks.length).toBe(1));

    expect(bareRunTasks[0]!.model).toBe("future-eng/future-model");
    await settleEngineRunChain(pi);
  });

  it("[V2-4①] pi id 派发 pi 引擎（现状主路径）行为不变：resolveModel 正常解析 + spawn 启动", async () => {
    const { service } = setupChat(agentDir);
    // mock spawn 计数文件级共享（跨用例累积）——以计数差归因本用例（单调递增，可确定性等待）
    const spawnCallsBefore = mockSpawn.mock.calls.length;
    const handle = await service.execute(baseOpts(agentDir, { model: PI_ID }));

    // record 身份字段产生于 execute 同步段——resolve 后立即快照（竞态依据同 V2-1a）。
    // pi 路径的 kickOffBackground → runSpawn 是 detached 链，不作为断言前置条件。
    const rec = service.collectRecords(10, "running").find((r) => r.id === handle.subagentId);
    expect(rec?.engine).toBeUndefined(); // pi 缺省不盖章（D5 零变化）
    expect(rec?.model).toBe(PI_ID);

    await vi.waitFor(() => expect(mockSpawn.mock.calls.length).toBeGreaterThan(spawnCallsBefore));
  });
});

// ============================================================
// B. pi 未命中跨引擎候选（V2-3 场景 3 + V2-4③ 零回归）
// ============================================================

describe("pi registry 未命中的跨引擎候选（u-h2 D2-4）", () => {
  let agentDir: string;

  beforeEach(() => {
    configureCore({ dataRoot: () => "/fake-cross-engine-data-root", log: () => {} });
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-engine-"));
    writeGlobalConfig(agentDir, { version: 1, maxConcurrent: 6 });
  });

  afterEach(() => {
    clearEngines();
    resetCoreForTests();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.clearAllMocks();
  });

  it("[V2-3] defaultEngine=pi + zcode id（pi 未命中，zcode 清单唯一命中）→ 错误附跨引擎候选段", async () => {
    const { service } = setupChat(agentDir);

    const err = await service.execute(baseOpts(agentDir, { model: ZCODE_FLASH })).catch((e: unknown) => e);
    const msg = (err as Error).message;

    // 既有全等裁决文案保留（V2-4③ 零回归面；首行带 (paramOverride) 来源前缀）
    expect(msg).toContain(`Model "${ZCODE_FLASH}" (paramOverride) is not a registry entry.`);
    // 场景 3 追加段：点破归属引擎 + 修正动作
    expect(msg).toContain(`This id matches the registry of engine 'zcode'.`);
    expect(msg).toContain(
      `👉 Retry with engine: 'zcode', or use a pi model from <available_provider_models>, ` +
        `or omit \`model\` to inherit the main agent model.`,
    );
  });

  it("[D2-4] 多引擎清单同时命中 → 不附候选（唯一命中才提示，避免误导）", async () => {
    const second = new ValidatingFakeEngine({ id: "zcode2", models: [ZCODE_FLASH] });
    const { service } = setupChat(agentDir, { extraEngine: second });

    const err = await service.execute(baseOpts(agentDir, { model: ZCODE_FLASH })).catch((e: unknown) => e);
    expect((err as Error).message).toContain("is not a registry entry");
    expect((err as Error).message).not.toContain("matches the registry of engine");
  });

  it("[V2-4③] pi id 大小写错误 → 仍报全等裁决错误（case variant 建议），不附跨引擎段", async () => {
    const { service } = setupChat(agentDir);

    const err = await service.execute(baseOpts(agentDir, { model: "pi-org/PI-MAIN" })).catch((e: unknown) => e);
    const msg = (err as Error).message;
    expect(msg).toContain('Model "pi-org/PI-MAIN" (paramOverride) is not a registry entry.');
    expect(msg).toContain("case variant");
    expect(msg).not.toContain("matches the registry of engine");
  });

  it("[D2-4] 跨引擎匹配按 strip thinking 后缀后的全名全等——含合法后缀的 id 仍可命中", async () => {
    const { service } = setupChat(agentDir);
    const err = await service.execute(baseOpts(agentDir, { model: `${ZCODE_FLASH}:max` })).catch((e: unknown) => e);
    expect((err as Error).message).toContain("This id matches the registry of engine 'zcode'.");
  });
});

// ============================================================
// C. workflow 路径 SAR：非 pi 校验调用点（V2-4②/④）
// ============================================================

function makeSarFakeZcode(opts?: { withValidateModel?: boolean }): { engine: EnginePort; runs: Array<{ task: AgentTaskSpec }> } {
  const engine = new ValidatingFakeEngine({ id: "zcode", models: [ZCODE_DEFAULT, ZCODE_FLASH], ...(opts ?? {}) });
  if (opts?.withValidateModel === false) {
    // 原型方法不可 deleteProperty——以同形状 plain object 替换（成员裁剪后的形态）
    const bare: EnginePort = {
      id: "zcode",
      capabilities: () => engine.capabilities(),
      probe: () => engine.probe(),
      run: (task, ctx) => engine.run(task, ctx),
      interact: (handle, action) => engine.interact(handle, action),
      read: (handle) => engine.read(handle),
    };
    return { engine: bare, runs: engine.runs };
  }
  return { engine, runs: engine.runs };
}

function makeMockPiService() {
  const executeAndAwait = vi.fn(async (): Promise<{ content: string; toolCalls: never[] }> => ({
    content: "from-pi",
    toolCalls: [],
  }));
  return { service: { executeAndAwait } as unknown as SubagentServiceType, executeAndAwait };
}

function sarOpts(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "task", description: "validation-test", ...overrides };
}

describe("workflow 路径 SAR：非 pi 引擎派发同步期 model 校验（u-h2 V2-4②/④）", () => {
  let tmpRoot: string;
  let agentDir: string;
  let prevDataDirEnv: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sar-model-validation-"));
    agentDir = path.join(tmpRoot, "pi-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    prevDataDirEnv = process.env["XYZ_AGENT_DATA_DIR"];
    process.env["XYZ_AGENT_DATA_DIR"] = path.join(tmpRoot, "engine-data");
    clearEngines();
    fs.mkdirSync(path.join(agentDir, "subagents"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "subagents", "config.json"),
      JSON.stringify({ version: 1, maxConcurrent: 6 }),
    );
  });

  afterEach(() => {
    if (prevDataDirEnv === undefined) delete process.env["XYZ_AGENT_DATA_DIR"];
    else process.env["XYZ_AGENT_DATA_DIR"] = prevDataDirEnv;
    clearEngines();
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.clearAllMocks();
  });

  it("[V2-4②] agent({engine:'zcode', model:<zcode id>}) → 不回归：engine.run 收到原样 model", async () => {
    const zcode = makeSarFakeZcode();
    registerEngine("zcode", () => zcode.engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(sarOpts({ engine: "zcode", model: ZCODE_FLASH }), new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(zcode.runs).toHaveLength(1);
    expect(zcode.runs[0]!.task.model).toBe(ZCODE_FLASH);
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
  });

  it("[V2-4④] agent({engine:'zcode', model:<pi id>}) → 同步期场景 2 错误入 result.error，不进 engine.run", async () => {
    const zcode = makeSarFakeZcode();
    registerEngine("zcode", () => zcode.engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(sarOpts({ engine: "zcode", model: PI_ID }), new AbortController().signal);

    // 「不 reject」契约：错误入 result.error（与 chat 路径同文案）
    expect(result.error).toContain(`model '${PI_ID}' is not available on engine 'zcode'.`);
    expect(result.error).toContain("Engine registries are independent");
    expect(result.error).toContain(ZCODE_FLASH);
    expect(result.error).toContain("engine default");
    // 同步期拒绝：未进入引擎执行（与 chat 路径 V2-2 同语义，无 prepare 期晚炸）
    expect(zcode.runs).toHaveLength(0);
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
  });

  it("[现状语义] SAR fake 引擎未实现 validateModel → 校验透传，既有路由测试场景零回归", async () => {
    const zcode = makeSarFakeZcode({ withValidateModel: false });
    registerEngine("zcode", () => zcode.engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(sarOpts({ engine: "zcode", model: "any-provider/any-model" }), new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(zcode.runs).toHaveLength(1);
    expect(zcode.runs[0]!.task.model).toBe("any-provider/any-model");
  });

  it("[V2-4①] workflow pi 路径不受影响：pi id 走 executeAndAwait 委托", async () => {
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(sarOpts({ model: PI_ID }), new AbortController().signal);

    expect(result.content).toBe("from-pi");
    expect(pi.executeAndAwait).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// D. P2-1 时序回归：record 注册 / emit 顺序
//
// 确定性依据（flake 加固 2026-09-05）：record entry（createRecordForMode → store.register
// → pi.appendEntry，record-store.ts 同步调用）与 pending:register emit
//（emitPendingRegister）都产生于 execute()/executeViaEngine() 的同一同步段——
// service.execute() 的 Promise resolve 时两笔必然已写入 eventLog。
//
// 因此本组断言【不等待 detached 引擎链】（不 waitFor zcode.runs / mockSpawn）：那条链
// 会继续向 eventLog 追加噪声（archive 的第二笔 subagent-record entry、pending:unregister），
// waitFor 的轮询窗口让断言评估时机落在链推进的任意交错点——重负载下即偶发失败形态
//（单跑全绿、全量偶发）。顺序锁定语义不变：第一笔 entry:subagent-record 必须先于
// 第一笔 emit:pending:register。
// ============================================================

describe("P2-1 路由先行 reorder 的时序回归锁定", () => {
  let agentDir: string;

  beforeEach(() => {
    configureCore({ dataRoot: () => "/fake-p21-data-root", log: () => {} });
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "p21-reorder-"));
    writeGlobalConfig(agentDir, { version: 1, maxConcurrent: 6 });
  });

  afterEach(() => {
    clearEngines();
    resetCoreForTests();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    vi.clearAllMocks();
  });

  it("[pi 缺省] record entry 写点先于 pending:register emit（既有顺序不变）", async () => {
    const { service, eventLog } = setupChat(agentDir);

    await service.execute(baseOpts(agentDir));

    const entryIdx = eventLog.indexOf("entry:subagent-record");
    const registerIdx = eventLog.indexOf("emit:pending:register");
    expect(entryIdx).toBeGreaterThanOrEqual(0);
    expect(registerIdx).toBeGreaterThanOrEqual(0);
    expect(entryIdx).toBeLessThan(registerIdx);
  });

  it("[非 pi 校验失败] 零 record entry、零 pending:register emit（不产生孤儿 record）", async () => {
    const { service, eventLog, zcode } = setupChat(agentDir);

    await expect(service.execute(baseOpts(agentDir, { engine: "zcode", model: PI_ID }))).rejects.toThrow(
      /is not available on engine 'zcode'/,
    );

    expect(eventLog).not.toContain("entry:subagent-record");
    expect(eventLog).not.toContain("emit:pending:register");
    expect(zcode.runs.length).toBe(0);
    expect(service.collectRecords(10, "all")).toHaveLength(0);
  });

  it("[非 pi 成功] record entry → pending:register 顺序与 pi 路径一致", async () => {
    const { service, eventLog, zcode, pi } = setupChat(agentDir);

    // execute() resolve 即同步段完成点：entry 与 emit 两笔此时已确定写入 eventLog
    //（不依赖 detached 引擎链推进——等待该链只会给断言引入负载敏感的评估时机，
    // 且链的后续写入〔archive 第二笔 entry / pending:unregister〕与断言语义无关）。
    await service.execute(baseOpts(agentDir, { engine: "zcode", model: ZCODE_FLASH }));

    const entryIdx = eventLog.indexOf("entry:subagent-record");
    const registerIdx = eventLog.indexOf("emit:pending:register");
    expect(entryIdx).toBeGreaterThanOrEqual(0);
    expect(registerIdx).toBeGreaterThan(entryIdx);
    // 引擎派发事实单独确定性等待（runs 数组只增不删，与 eventLog 时序断言解耦）
    await vi.waitFor(() => expect(zcode.runs.length).toBe(1));
    // 链静止后再离开用例（afterEach rmSync 竞争防御，见 helper 注释）
    await settleEngineRunChain(pi);
  });
});

// ============================================================
// E. zcode 引擎 validateModel 委托（真实 preparer + 临时 v2 config）
// ============================================================

describe("ZcodeEngine.validateModel 委托 resolveZcodeModelRef（u-h2 D2-2）", () => {
  let tmpRoot: string;
  let v2Path: string;

  const PROVIDER_A = "builtin:bigmodel-coding-plan";
  const PROVIDER_B = "e512d53e-test-provider";

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-validate-model-"));
    v2Path = path.join(tmpRoot, "v2-config.json");
    fs.writeFileSync(
      v2Path,
      JSON.stringify({
        provider: {
          [PROVIDER_A]: {
            options: { apiKey: "key-a", baseURL: "https://a.example" },
            models: { "GLM-5.3": {}, "GLM-5.3-Flash": {} },
          },
          [PROVIDER_B]: {
            options: { apiKey: "key-b" },
            models: { "mimo-v2.5-pro": {} },
          },
        },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeEngine(): ZcodeEngine {
    return new ZcodeEngine({ engineDataDir: () => path.join(tmpRoot, "data"), sources: { v2ConfigPath: v2Path } });
  }

  it("显式全名命中 → canonicalRef 原样返回", () => {
    expect(makeEngine().validateModel(ZCODE_FLASH).canonicalRef).toBe(ZCODE_FLASH);
  });

  it("undefined → 引擎缺省模型（ZCODE_FALLBACK_DEFAULT_MODEL 链）", () => {
    expect(makeEngine().validateModel(undefined).canonicalRef).toBe(ZCODE_DEFAULT);
  });

  it("短名 → 缺省 provider 归一化 canonical 全名", () => {
    expect(makeEngine().validateModel("GLM-5.3-Flash").canonicalRef).toBe(ZCODE_FLASH);
  });

  it("未知 provider → ZcodePrepareError(model_not_available)", () => {
    expect(() => makeEngine().validateModel("pi-org/pi-main")).toThrow(ZcodePrepareError);
    try {
      makeEngine().validateModel("pi-org/pi-main");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("model_not_available");
    }
  });

  it("provider 存在但未配 apiKey → ZcodePrepareError(engine_credential_missing)", () => {
    // withKey 非空（PROVIDER_A 带凭据）+ 目标 provider 无 key → 命中 preparer「provider
    // 存在但未配置 apiKey」分支（非「找不到任何带 apiKey provider」分支）
    fs.writeFileSync(
      v2Path,
      JSON.stringify({
        provider: {
          [PROVIDER_A]: { options: { apiKey: "key-a" }, models: { "GLM-5.3": {} } },
          "no-key-provider": { options: { baseURL: "https://x.example" }, models: { M1: {} } },
        },
      }),
    );
    try {
      makeEngine().validateModel("no-key-provider/M1");
      throw new Error("should have thrown ZcodePrepareError");
    } catch (err) {
      expect(err).toBeInstanceOf(ZcodePrepareError);
      expect((err as ZcodePrepareError).code).toBe("engine_credential_missing");
    }
  });
});
