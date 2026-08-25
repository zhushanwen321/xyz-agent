// subprocess-agent-runner-routing.test.ts —— P4 SAR 路由集成测试（验收 1/2/3 的
// runner 级证据面）：三层优先级落到 run、fallback 留痕进 ExecuteOptions（record 投影
// 的入参面）、守卫/strict 报错入 result.error、journal 池 key 对齐（对齐点③：落盘
// 路径 = 引擎 onPoolResolved 声明的池 key 派生路径）。
//
// fake 注入：pi 侧 mock SubagentService（executeAndAwait 记录入参）；zcode 侧向
// registry 注册 fake EnginePort（probe 结果可注入）；frontmatter/全局配置经真实
// ModelConfigService 单例（agentDir 指向临时目录，真实落盘 .md 与 config.json）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentCallOpts, AgentResult } from "../../orchestration/models/types.ts";
import type { RunContext } from "../engine/port.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import type { EnginePort, ProbeReport } from "../engine/types.ts";
import { ModelConfigService, setModelConfigService } from "../model-config-service.ts";
import { SubprocessAgentRunner } from "../subprocess-agent-runner.ts";
import type { SubagentService } from "../subagent-service.ts";
import type { ExecuteOptions } from "../types.ts";

// ── fake 引擎（registry 登记，probe/run 可记录；run 模拟 onPoolResolved + 事件 emit）──

interface FakeEngineCalls {
  probed: number;
  runs: Array<{ taskSpec: unknown; ctx: RunContext }>;
}

function makeFakeZcodeEngine(probeOk: boolean): { engine: EnginePort; calls: FakeEngineCalls } {
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
      ctx.onPoolResolved?.("home-test-provider-m1");
      ctx.onEvent?.({ type: "message_end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
      ctx.onEvent?.({ type: "turn_end" });
      return Promise.resolve({
        handle: { data: { v: 1, engineId: "zcode", sessionRef: {}, poolKey: "home-test-provider-m1", adapterVersion: "t" } },
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
  const service = { executeAndAwait } as unknown as SubagentService;
  return { service, executeOpts, executeAndAwait };
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sar-routing-"));
  agentDir = path.join(tmpRoot, "pi-agent");
  fs.mkdirSync(agentDir, { recursive: true });
  // journal 落盘隔离（getEngineDataDir 的权威通道）：tmpRoot 下，不污染真实目录
  prevDataDirEnv = process.env["XYZ_AGENT_DATA_DIR"];
  process.env["XYZ_AGENT_DATA_DIR"] = path.join(tmpRoot, "engine-data");
  clearEngines();
});

afterEach(() => {
  if (prevDataDirEnv === undefined) delete process.env["XYZ_AGENT_DATA_DIR"];
  else process.env["XYZ_AGENT_DATA_DIR"] = prevDataDirEnv;
  clearEngines();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
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
    // 对齐点③断言：journal 落在引擎声明的池 key 目录（非 pi 'shared' 占位路径）
    const poolDir = path.join(tmpRoot, "engine-data", "engines", "zcode", "home-test-provider-m1");
    const journals = fs.existsSync(poolDir) ? fs.readdirSync(poolDir) : [];
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatch(/^journal-sa-.+\.jsonl$/);
    const sharedDir = path.join(tmpRoot, "engine-data", "engines", "zcode", "shared");
    expect(fs.existsSync(sharedDir)).toBe(false); // 占位 poolKey 未产生错位落盘
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
});
