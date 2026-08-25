// routing.test.ts —— P4 配置路由三层 + probe fallback 三守卫 + strict（验收 1/2 的
// 单测面）。fake probe/getEngine 注入（不依赖真机引擎与真实探针）。

import { describe, expect, it } from "vitest";

import type { EnginePort, RunContext } from "../port.ts";
import { DEFAULT_ENGINE_ID, EngineNotFoundError } from "../registry.ts";
import { EngineError } from "../common/errors.ts";
import type { AgentTaskSpec, ProbeReport, SessionView } from "../types.ts";
import { resolveEngineRouting, routeEngine, type EngineRouteOptions } from "../routing.ts";

/** 最小可运行假引擎（probe 结果可注入）。 */
function makeFakeEngine(id: string, probeOk: boolean): EnginePort {
  return {
    id,
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
    probe: () =>
      Promise.resolve(
        probeOk
          ? { ok: true, engineVersion: "1.0.0", checks: [{ name: "stub", ok: true }] }
          : {
              ok: false,
              engineVersion: "",
              checks: [{ name: "binary", ok: false, detail: "missing" }],
              error: { code: "engine_probe_failed", recovery: "reinstall the engine binary and retry the probe" },
            } satisfies ProbeReport,
      ),
    run: (_t: AgentTaskSpec, _c: RunContext) => Promise.reject(new Error("fake: run not implemented")),
    interact: () => Promise.resolve({ ok: false, code: "engine_capability_unsupported", message: "stub" }),
    read: (_h: Parameters<EnginePort["read"]>[0]): Promise<SessionView> =>
      Promise.resolve({ engineId: id, turns: [], source: "outcome-only" }),
  };
}

/** routeEngine 的装配器：注册 {pi:ok, zcode:probeOk} 两引擎。 */
function makeRoute(overrides?: {
  zcodeProbeOk?: boolean;
  strict?: boolean;
  routing?: Partial<EngineRouteOptions["routing"]>;
  taskModel?: string;
}) {
  const engines = new Map<string, EnginePort>();
  engines.set(DEFAULT_ENGINE_ID, makeFakeEngine("pi", true));
  engines.set("zcode", makeFakeEngine("zcode", overrides?.zcodeProbeOk ?? true));
  const probeCalls: string[] = [];
  const opts: EngineRouteOptions = {
    routing: overrides?.routing ?? {},
    taskModel: overrides?.taskModel,
    strict: overrides?.strict ?? false,
    probe: (id) => {
      probeCalls.push(id);
      return engines.get(id)!.probe();
    },
    getEngineFn: (id) => {
      const e = engines.get(id);
      if (e === undefined) throw new EngineNotFoundError(id, [...engines.keys()]);
      return e;
    },
    hasEngineFn: (id) => engines.has(id),
    listEnginesFn: () => [...engines.keys()],
  };
  return { opts, probeCalls, engines };
}

// ── 三层优先级（验收 1）──

describe("resolveEngineRouting：三层优先级", () => {
  it("无任何指定 → 全局缺省 'pi'", () => {
    expect(resolveEngineRouting({})).toEqual({ engineId: "pi", source: "default" });
  });

  it("全局默认引擎指定（config defaultEngine=zcode）→ zcode", () => {
    expect(resolveEngineRouting({ globalDefaultEngine: "zcode" })).toEqual({ engineId: "zcode", source: "default" });
  });

  it("frontmatter 指定 > 全局默认", () => {
    expect(resolveEngineRouting({ agentEngine: "zcode", globalDefaultEngine: "pi" })).toEqual({
      engineId: "zcode",
      source: "frontmatter",
    });
  });

  it("调用参数 > frontmatter > 全局默认（三层全设时调用参数胜）", () => {
    expect(
      resolveEngineRouting({ callEngine: "pi", agentEngine: "zcode", globalDefaultEngine: "zcode" }),
    ).toEqual({ engineId: "pi", source: "call" });
  });

  it("空串视为未指定（AgentCallOpts.engine='' 落下一层）", () => {
    expect(resolveEngineRouting({ callEngine: "", agentEngine: "zcode" })).toEqual({
      engineId: "zcode",
      source: "frontmatter",
    });
  });
});

describe("routeEngine：路由 + 探针 + 守卫编排（验收 1/2）", () => {
  it("缺省 pi：免探（零行为变化口径）直接返回引擎", async () => {
    const { opts, probeCalls, engines } = makeRoute();
    const result = await routeEngine(opts);
    expect(result.engine).toBe(engines.get("pi"));
    expect(result.engineId).toBe("pi");
    expect(result.engineFallback).toBeUndefined();
    expect(probeCalls).toEqual([]); // pi 缺省路径不探（D7 轻量口径）
  });

  it("frontmatter 指定 zcode + probe ok：返回 zcode 引擎，无 fallback", async () => {
    const { opts, probeCalls, engines } = makeRoute({ routing: { agentEngine: "zcode" } });
    const result = await routeEngine(opts);
    expect(result.engine).toBe(engines.get("zcode"));
    expect(result.engineId).toBe("zcode");
    expect(result.engineFallback).toBeUndefined();
    expect(probeCalls).toEqual(["zcode"]);
  });

  it("调用参数指定 zcode：覆盖 frontmatter 的 pi（透传链 A7）", async () => {
    const { opts } = makeRoute({ routing: { callEngine: "zcode", agentEngine: "pi" } });
    const result = await routeEngine(opts);
    expect(result.engineId).toBe("zcode");
    expect(result.source).toBe("call");
  });

  it("未注册 id（调用参数层）：engine_not_found，文案含注册清单（前置暴露）", async () => {
    const { opts } = makeRoute({ routing: { callEngine: "nonexistent" } });
    await expect(routeEngine(opts)).rejects.toThrowError(EngineNotFoundError);
    await expect(routeEngine(opts)).rejects.toThrowError(/Registered engines: pi, zcode/);
  });

  // ── fallback 与三守卫（验收 2）──

  it("frontmatter 指定 zcode + probe 失败 → 路由回 pi + engineFallback 留痕（A9①）", async () => {
    const { opts, engines } = makeRoute({ zcodeProbeOk: false, routing: { agentEngine: "zcode" } });
    const result = await routeEngine(opts);
    expect(result.engine).toBe(engines.get("pi"));
    expect(result.engineId).toBe("pi");
    expect(result.requestedEngineId).toBe("zcode");
    expect(result.engineFallback).toEqual({ from: "zcode", reason: "engine_probe_failed" });
  });

  it("守卫 a：调用参数显式指定 + probe 失败 → 不兜底，报 engine_probe_failed", async () => {
    const { opts } = makeRoute({ zcodeProbeOk: false, routing: { callEngine: "zcode" } });
    const err = await routeEngine(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("engine_probe_failed");
    expect((err as EngineError).message).toContain("调用参数显式指定");
    expect((err as EngineError).recovery).toContain("retry the probe");
  });

  it("守卫 b（首期与 a 合流）：AgentTaskSpec.requires 形状预留存在且不参与首期判定", async () => {
    // 形状预留的类型面由 typecheck 守护；行为面：frontmatter 指定（非 call）+ 无 model
    // → 仍走 fallback（守卫 b 独立生效留给 requires 下钻，见 types.ts 注释）
    const { opts } = makeRoute({ zcodeProbeOk: false, routing: { agentEngine: "zcode" } });
    const result = await routeEngine(opts);
    expect(result.engineFallback).toBeDefined();
  });

  it("守卫 c：显式 model + probe 失败 → 不换引擎，报 model_not_available", async () => {
    const { opts } = makeRoute({
      zcodeProbeOk: false,
      routing: { agentEngine: "zcode" },
      taskModel: "builtin:bigmodel-coding-plan/GLM-5.3",
    });
    const err = await routeEngine(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("model_not_available");
    expect((err as EngineError).message).toContain("GLM-5.3");
  });

  it("守卫 c 不误伤：无显式 model 时 probe 失败正常 fallback", async () => {
    const { opts } = makeRoute({ zcodeProbeOk: false, routing: { agentEngine: "zcode" } });
    const result = await routeEngine(opts);
    expect(result.engineId).toBe("pi");
  });

  it("strict=true：frontmatter 层 probe 失败也直接报 engine_probe_failed（A5）", async () => {
    const { opts } = makeRoute({ zcodeProbeOk: false, strict: true, routing: { agentEngine: "zcode" } });
    const err = await routeEngine(opts).catch((e: unknown) => e);
    expect((err as EngineError).code).toBe("engine_probe_failed");
    expect((err as EngineError).message).toContain("strict");
  });

  it("全局默认引擎自身 probe 失败（defaultEngine=zcode）：fallback 回内置 pi", async () => {
    const { opts } = makeRoute({ zcodeProbeOk: false, routing: { globalDefaultEngine: "zcode" } });
    const result = await routeEngine(opts);
    expect(result.engineId).toBe("pi");
    expect(result.engineFallback).toEqual({ from: "zcode", reason: "engine_probe_failed" });
  });
});
