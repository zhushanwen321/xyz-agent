// subprocess-agent-runner-routing.test.ts —— P4 SAR 路由集成测试（验收 1/2/3 的
// runner 级证据面）：三层优先级落到 run、fallback 留痕进 ExecuteOptions（record 投影
// 的入参面）、守卫/strict 报错入 result.error、journal 池 key 对齐（对齐点③：落盘
// 路径 = 引擎 onPoolResolved 声明的池 key 派生路径）。
//
// fake 注入：pi 侧 mock SubagentService（executeAndAwait 记录入参）；zcode 侧向
// registry 注册 fake EnginePort（probe 结果可注入）；frontmatter/全局配置经真实
// ModelConfigService 单例（agentDir 指向临时目录，真实落盘 .md 与 config.json）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentCallOpts, AgentResult } from "../../orchestration/models/types.ts";
import type { EnginePort, RunContext } from "../engine/port.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type { AgentOutcome, EngineCapabilities, ProbeReport } from "../engine/types.ts";
import { ModelConfigService, setModelConfigService } from "../model-config-service.ts";
// W10（§2.10 ②）：子进程句柄断言改读 core 侧状态镜像（host/spawned-children——
// 协议化后 spawnedChildren 持有方在引擎进程，core 消费镜像面；判据 pid 同构）。
import {
  coreSpawnedChildrenMirror,
  _resetCoreSpawnedChildrenMirrorForTest,
} from "../engine/host/spawned-children.ts";
import { SubprocessAgentRunner } from "../subprocess-agent-runner.ts";
import type { SubagentService } from "../subagent-service.ts";
import type { ExecuteOptions } from "../types.ts";

// ── fake 引擎（registry 登记，probe/run 可记录；run 模拟 onPoolResolved + 事件 emit）──

interface FakeEngineCalls {
  probed: number;
  runs: Array<{ taskSpec: unknown; ctx: RunContext }>;
}

/** fake zcode 引擎的池 key 缺省值（机制跟随性用例：任意 key 落对应目录）。 */
const FAKE_POOL_KEY = "home-test-provider-m1";

function makeFakeZcodeEngine(probeOk: boolean, poolKey: string = FAKE_POOL_KEY): { engine: EnginePort; calls: FakeEngineCalls } {
  const calls: FakeEngineCalls = { probed: 0, runs: [] };
  const engine: EnginePort = {
    id: "zcode",
    capabilities: () => ({
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "none",
      sessionRead: "outcome-only",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: false,
    }),
    probe: () => {
      calls.probed++;
      const report: ProbeReport = probeOk
        ? { ok: true, engineVersion: "0.16.5", checks: [{ name: "stub", ok: true }] }
        : {
            ok: false,
            engineVersion: "",
            checks: [{ name: "binary", ok: false, detail: "missing" }],
            error: { code: "engine_probe_failed", recovery: "reinstall zcode and retry the probe" },
          };
      return Promise.resolve(report);
    },
    run: (taskSpec, ctx) => {
      calls.runs.push({ taskSpec, ctx });
      // 对齐点③模拟：prepare 期声明池 key → 事件 emit（zcode coarse 形态：终态后合成）
      ctx.onPoolResolved?.(poolKey);
      ctx.onEvent?.({ type: "message_end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
      ctx.onEvent?.({ type: "turn_end" });
      return Promise.resolve({
        handle: { data: { v: 1, engineId: "zcode", sessionRef: {}, poolKey, adapterVersion: "t" } },
        outcome: { engineId: "zcode", content: "from-zcode" },
      });
    },
    interact: () => Promise.resolve({ ok: false, code: "engine_capability_unsupported", message: "stub" }),
    read: () => Promise.resolve({ engineId: "zcode", turns: [], source: "outcome-only" }),
  };
  return { engine, calls };
}

// ── mock pi 编排服务（executeAndAwait 入参记录——record 投影的入参面）──

function makeMockPiService() {
  const executeOpts: ExecuteOptions[] = [];
  const executeAndAwait = vi.fn(async (opts: ExecuteOptions): Promise<AgentResult> => {
    executeOpts.push(opts);
    return { content: "from-pi", durationMs: 1, toolCalls: [] };
  });
  // [D4 聚合连带] SAR 构造器经 asEngineService 显式视图取引擎服务面——fake 的
  // face 即自身，getter 直接返回 self。
  // getSessionRootId = [F6] SAR runCtx 注入的根 session id 访问（替身恒 null = 不上 wire）。
  const service = { executeAndAwait, getSessionRootId: () => null } as unknown as SubagentService & { asEngineService: unknown };
  (service as { asEngineService: unknown }).asEngineService = service;
  // [W3] 登记当前 mock 服务——委托式替身 port 的工厂闭包按它路由（getEngine 惰性）。
  currentPiService = service as unknown as SubagentService;
  return { service, executeOpts, executeAndAwait };
}

// ── [W3] 委托式替身 pi port（原 inproc PiEngine 的 workflow 分支形态）──
// run() 还原引擎内 task→ExecuteOptions 映射（含 engine='pi' 留痕与 engineFallback
// 透传——两断言的契约面）后委托 mock 服务的 executeAndAwait。

let currentPiService: SubagentService | undefined;

function piTaskToExecuteOptions(task: AgentCallOpts, ctx: RunContext): ExecuteOptions {
  const rawSlug = task.description ?? task.agent ?? "workflow-agent";
  return {
    task: task.prompt,
    slug: rawSlug.length > 35 ? rawSlug.slice(0, 35) : rawSlug,
    agent: task.agent,
    model: task.model,
    thinkingLevel: task.thinkingLevel,
    skillPath: task.skillPath,
    appendSystemPrompt: task.appendSystemPrompt,
    schema: task.schema,
    schemaEnv: task.schemaEnv,
    maxTurns: task.maxTurns,
    graceTurns: task.graceTurns,
    ctxModel: ctx.ctxModel,
    fork: task.fork,
    worktree: task.worktree,
    cwd: task.cwd,
    conversation: task.conversation,
    idleTimeoutMs: task.idleTimeoutMs,
    // P4 引擎留痕（D9①）：实际执行引擎 id 恒 pi（原 PiEngine.run workflow 分支同款）
    engine: "pi",
    ...(ctx.engineFallback !== undefined ? { engineFallback: ctx.engineFallback } : {}),
  };
}

function makeDelegatingPiPort(getService: () => SubagentService | undefined): EnginePort {
  return {
    id: "pi",
    capabilities: (): EngineCapabilities => ({
      schemaEnforcement: "native",
      steer: "unsupported",
      conversation: "native",
      personaInjection: "flag",
      eventGranularity: "stream",
      sandbox: "emulated",
      sessionRead: "full",
      resume: "native",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: true,
    }),
    probe: async (): Promise<ProbeReport> => ({ ok: true, engineVersion: "fake", checks: [] }),
    run: async (task, ctx) => {
      const service = getService();
      if (service === undefined) throw new Error("mock pi service not installed");
      const result = await (service as unknown as {
        executeAndAwait: (opts: ExecuteOptions, signal?: AbortSignal) => Promise<AgentResult>;
      }).executeAndAwait(piTaskToExecuteOptions(task, ctx), ctx.signal);
      const outcome: AgentOutcome = {
        content: result.content,
        durationMs: result.durationMs,
        error: result.error,
        engineId: "pi",
      };
      return {
        handle: { data: { v: 1, engineId: "pi", sessionRef: {}, poolKey: "shared", adapterVersion: "fake-sar" } },
        outcome,
      };
    },
    interact: async () => ({ ok: false, code: "engine_interact_failed", message: "not supported in this test" }),
    read: async () => ({ engineId: "pi", turns: [], source: "outcome-only" }),
  };
}

// ── 环境 ──

let tmpRoot: string;
let agentDir: string;
let prevDataDirEnv: string | undefined;

function writeGlobalConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(agentDir, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "subagents", "config.json"), JSON.stringify(cfg));
}

function writeAgentMd(name: string, frontmatter: string): string {
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  const p = path.join(agentDir, "agents", `${name}.md`);
  fs.writeFileSync(p, `---\n${frontmatter}\n---\nbody`);
  return p;
}

function makeOpts(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return {
    prompt: "task",
    description: "routing-test",
    ...overrides,
  };
}

/** 装配真实 ModelConfigService 单例（agentDir 指临时目录——frontmatter/config.json 真实落盘）。 */
function installModelService(cfg?: Record<string, unknown>): void {
  if (cfg !== undefined) writeGlobalConfig(cfg);
  setModelConfigService(new ModelConfigService({ agentDir, cwd: tmpRoot }));
}

beforeEach(() => {
  _resetCoreSpawnedChildrenMirrorForTest();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sar-routing-"));
  agentDir = path.join(tmpRoot, "pi-agent");
  fs.mkdirSync(agentDir, { recursive: true });
  // journal 落盘隔离（getEngineDataDir 的权威通道）：tmpRoot 下，不污染真实目录
  prevDataDirEnv = process.env["XYZ_AGENT_DATA_DIR"];
  process.env["XYZ_AGENT_DATA_DIR"] = path.join(tmpRoot, "engine-data");
  clearEngines();
  currentPiService = undefined;
  // [U-2 一致性修复 → W3] resolveHostPiEnginePort 对已注册 port 原样返回——登记
  // 委托式替身 pi port（registry 命中即路由命中；mock 服务的 DI 语义保持不变）。
  registerEngine("pi", () => makeDelegatingPiPort(() => currentPiService));
});

afterEach(() => {
  if (prevDataDirEnv === undefined) delete process.env["XYZ_AGENT_DATA_DIR"];
  else process.env["XYZ_AGENT_DATA_DIR"] = prevDataDirEnv;
  clearEngines();
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("SAR 路由集成（P4 验收 1/2/3）", () => {
  it("缺省路径：无任何指定 → pi（本地 DI 绑定），ExecuteOptions.engine='pi' 留痕", async () => {
    installModelService();
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts(), new AbortController().signal);

    expect(result.content).toBe("from-pi");
    expect(pi.executeOpts[0]?.engine).toBe("pi"); // record 投影的入参面（验收 3）
    expect(pi.executeOpts[0]?.engineFallback).toBeUndefined();
  });

  it("frontmatter 指定 zcode（probe ok）→ registry 引擎执行；journal 落盘路径 = 引擎池 key（对齐点③）", async () => {
    const agentRef = writeAgentMd("reviewer", "name: reviewer\ndescription: d\nengine: zcode");
    installModelService();
    const { engine, calls } = makeFakeZcodeEngine(true);
    registerEngine("zcode", () => engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts({ agent: agentRef }), new AbortController().signal);

    expect(result.content).toBe("from-zcode");
    expect(calls.runs).toHaveLength(1);
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
    // 机制跟随性断言：journal 落在引擎声明的池 key 目录（任意 key 落对应目录——
    // 真实 zcode 引擎 poolKey 恒 'shared'，对齐真实行为的断言见下一用例）
    const poolDir = path.join(tmpRoot, "engine-data", "engines", "zcode", FAKE_POOL_KEY);
    const journals = fs.existsSync(poolDir) ? fs.readdirSync(poolDir) : [];
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatch(/^journal-sa-.+\.jsonl$/);
  });

  it("journal 落盘对齐真实行为：poolKey 'shared' → engines/zcode/shared/journal-<taskId>.jsonl", async () => {
    // 生产 zcode 引擎 poolKey 恒 'shared'（ZCODE_SHARED_POOL_KEY）——fake 以同 key
    // 声明，断言 journal 精确落 shared 池目录（旧池化时代「shared 目录不存在」的
    // 反向锚定已随池化删除，此处锚定现行正向语义）
    const agentRef = writeAgentMd("reviewer", "name: reviewer\ndescription: d\nengine: zcode");
    installModelService();
    const { engine, calls } = makeFakeZcodeEngine(true, "shared");
    registerEngine("zcode", () => engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    await sar.run(makeOpts({ agent: agentRef }), new AbortController().signal);

    const taskId = calls.runs[0]?.ctx.taskId;
    expect(taskId).toMatch(/^sa-/);
    const sharedPoolDir = path.join(tmpRoot, "engine-data", "engines", "zcode", "shared");
    expect(fs.readdirSync(sharedPoolDir)).toEqual([`journal-${taskId}.jsonl`]);
  });

  it("调用参数 engine 覆盖 frontmatter（三层优先级落到 run，A7）", async () => {
    const agentRef = writeAgentMd("reviewer", "name: reviewer\ndescription: d\nengine: zcode");
    installModelService();
    const zcode = makeFakeZcodeEngine(true);
    registerEngine("zcode", () => zcode.engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    await sar.run(makeOpts({ agent: agentRef, engine: "pi" }), new AbortController().signal);

    expect(zcode.calls.runs).toHaveLength(0);
    expect(pi.executeOpts).toHaveLength(1); // 调用参数显式 pi 胜出
  });

  it("全局默认引擎（config defaultEngine=zcode）生效", async () => {
    installModelService({ version: 1, maxConcurrent: 6, defaultEngine: "zcode" });
    const { engine, calls } = makeFakeZcodeEngine(true);
    registerEngine("zcode", () => engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    await sar.run(makeOpts(), new AbortController().signal);
    expect(calls.runs).toHaveLength(1);
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
  });

  it("frontmatter zcode probe 失败 → 路由回 pi + engineFallback 进 ExecuteOptions（record 留痕面，A9①）", async () => {
    const agentRef = writeAgentMd("reviewer", "name: reviewer\ndescription: d\nengine: zcode");
    installModelService();
    const zcode = makeFakeZcodeEngine(false);
    registerEngine("zcode", () => zcode.engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts({ agent: agentRef }), new AbortController().signal);

    expect(result.content).toBe("from-pi");
    expect(pi.executeOpts[0]?.engine).toBe("pi");
    expect(pi.executeOpts[0]?.engineFallback).toEqual({ from: "zcode", reason: "engine_probe_failed" });
    expect(zcode.calls.probed).toBe(1);
  });

  it("调用参数显式 zcode + probe 失败 → 不兜底，result.error 含 engine_probe_failed（守卫 a，A9②）", async () => {
    installModelService();
    const zcode = makeFakeZcodeEngine(false);
    registerEngine("zcode", () => zcode.engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts({ engine: "zcode" }), new AbortController().signal);

    expect(result.content).toBe("");
    expect(result.error).toContain("engine_probe_failed");
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
  });

  it("frontmatter zcode + 显式 model + probe 失败 → model_not_available（守卫 c）", async () => {
    const agentRef = writeAgentMd("reviewer", "name: reviewer\ndescription: d\nengine: zcode");
    installModelService();
    const zcode = makeFakeZcodeEngine(false);
    registerEngine("zcode", () => zcode.engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(
      makeOpts({ agent: agentRef, model: "builtin:bigmodel-coding-plan/GLM-5.3" }),
      new AbortController().signal,
    );

    expect(result.error).toContain("model_not_available");
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
  });

  it("strict=true（config engineRouting.strict）→ frontmatter 层 probe 失败直接报错（A5）", async () => {
    const agentRef = writeAgentMd("reviewer", "name: reviewer\ndescription: d\nengine: zcode");
    installModelService({ version: 1, maxConcurrent: 6, engineRouting: { strict: true } });
    const zcode = makeFakeZcodeEngine(false);
    registerEngine("zcode", () => zcode.engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts({ agent: agentRef }), new AbortController().signal);

    expect(result.error).toContain("engine_probe_failed");
    expect(result.error).toContain("strict");
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
  });

  it("调用参数未注册 id → engine_not_found 入 result.error（文案含注册清单）", async () => {
    installModelService();
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts({ engine: "no-such-engine" }), new AbortController().signal);

    expect(result.error).toContain("engine_not_found");
    expect(result.error).toContain("Registered engines:");
  });

  it("frontmatter 未注册 id（解析期拦截）→ SAR 转错误结果（不 crash）", async () => {
    // frontmatter 校验在 agent 解析期（agent-registry 抛 EngineNotFoundError）——经
    // ModelConfigService.getAgentConfig 到达 SAR 路由装配，SAR catch 转 result.error
    const agentRef = writeAgentMd("broken", "name: broken\ndescription: d\nengine: ghost-engine");
    installModelService();
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts({ agent: agentRef }), new AbortController().signal);

    expect(result.error).toContain("engine_not_found");
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
  });

  it("[D10] RunContext.onChildSpawned 注入：子进程注册进 spawnedChildren，退出后按句移除", async () => {
    // C-ext-17 路径①回归：SAR 构造的 RunContext 必须提供 onChildSpawned（引擎 spawn
    // 后回调 → session-runner spawnedChildren 记账 → dispose killAll 收割兜底可见）
    const agentRef = writeAgentMd("reviewer", "name: reviewer\ndescription: d\nengine: zcode");
    installModelService();
    const { engine, calls } = makeFakeZcodeEngine(true);
    registerEngine("zcode", () => engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    await sar.run(makeOpts({ agent: agentRef }), new AbortController().signal);

    const ctx = calls.runs[0]?.ctx;
    expect(ctx?.onChildSpawned).toBeTypeOf("function");
    // 引擎回调（真实引擎在 spawn 成功后同步调）→ 按 taskId（'sa-' 记账 key）注册可见
    const child = spawn(process.execPath, ["-e", ""]);
    ctx?.onChildSpawned?.(child);
    expect(coreSpawnedChildrenMirror().getChildByRecord(ctx.taskId)?.pid).toBe(child.pid);
    // 按句移除断言（W10 注）：inproc 双模下子进程退出不回灌 host/childStateChanged
    // （该通道是 cli 协议形态专属）——镜像移除断言由 protocol-blackbox 的
    // childStateChanged 用例承载；此处等待 close 仅保证进程面收口不悬挂。
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  });

  // ── [D3-④] SAR 路径预检（capabilities 驱动；唯一有意行为变化 = zcode+worktree）──

  it("[D3-④] zcode + worktree:true → engine_capability_unsupported（workflow 域漏拦缺口修复），无 engine.run、无 journal 产物", async () => {
    const agentRef = writeAgentMd("reviewer", "name: reviewer\ndescription: d\nengine: zcode");
    installModelService();
    const { engine, calls } = makeFakeZcodeEngine(true);
    registerEngine("zcode", () => engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts({ agent: agentRef, worktree: true }), new AbortController().signal);

    expect(result.error).toContain("engine_capability_unsupported");
    expect(result.error).toContain("worktree");
    // 无进程创建 + 无 journal 落盘（拒绝在 wiring/run 之前）
    expect(calls.runs).toHaveLength(0);
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
    const enginesRoot = path.join(tmpRoot, "engine-data", "engines");
    expect(fs.existsSync(enginesRoot) ? fs.readdirSync(enginesRoot) : []).toEqual([]);
  });

  it("[D3-④] zcode + maxTurns / fork → engine_capability_unsupported（现状行为保持的正向守护）", async () => {
    const agentRef = writeAgentMd("reviewer", "name: reviewer\ndescription: d\nengine: zcode");
    installModelService();
    const { engine, calls } = makeFakeZcodeEngine(true);
    registerEngine("zcode", () => engine);
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const maxTurnsResult = await sar.run(makeOpts({ agent: agentRef, maxTurns: 5 }), new AbortController().signal);
    expect(maxTurnsResult.error).toContain("engine_capability_unsupported");
    expect(maxTurnsResult.error).toContain("maxTurns");
    expect(maxTurnsResult.error).toContain("capabilities.maxTurns = false");

    const forkResult = await sar.run(makeOpts({ agent: agentRef, fork: true }), new AbortController().signal);
    expect(forkResult.error).toContain("engine_capability_unsupported");
    expect(forkResult.error).toContain("fork");
    expect(calls.runs).toHaveLength(0);
  });

  it("[V4⑤ 反向] pi + maxTurns → 直通不拦（pi 既有合法能力零回归），executeAndAwait 收到 maxTurns", async () => {
    installModelService();
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts({ maxTurns: 3 }), new AbortController().signal);

    expect(result.content).toBe("from-pi");
    expect(pi.executeOpts[0]?.maxTurns).toBe(3);
  });
});

// [U-2 一致性修复] D4 错误契约：pi 未注册（引擎包未装/发现失败）时普通 run 路径
// 不再静默直构 inproc——派发期显式 engine_not_found + 安装指引（与 zcode 对称）。
describe("pi 未注册 → engine_not_found（D4 契约，U-2 修复锚定）", () => {
  it("pi 不在 registry → run 结果 error 含 engine_not_found + 安装指引，不静默走 inproc", async () => {
    clearEngines(); // 覆盖 beforeEach 的 inproc pi 登记——模拟发现失败/未装包
    installModelService();
    const pi = makeMockPiService();
    const sar = new SubprocessAgentRunner({ subagentService: pi.service });

    const result = await sar.run(makeOpts(), new AbortController().signal);

    expect(result.error).toContain("engine_not_found");
    expect(result.error).toContain("No engine packages were discovered");
    expect(result.error).toMatch(/install an engine package/i);
    expect(pi.executeAndAwait).not.toHaveBeenCalled();
  });
});
