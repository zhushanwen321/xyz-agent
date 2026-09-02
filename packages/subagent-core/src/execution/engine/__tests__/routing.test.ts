// routing.test.ts —— P4 配置路由三层 + probe fallback 三守卫 + strict（验收 1/2 的
// 单测面）。fake probe/getEngine 注入（不依赖真机引擎与真实探针）。

import { describe, expect, it } from "vitest";

import type { EnginePort, RunContext } from "../port.ts";
import { DEFAULT_ENGINE_ID, EngineNotFoundError } from "../registry.ts";
import { EngineError } from "../common/errors.ts";
import type { ProbeReport, SessionView } from "../types.ts";
import type { AgentCallOpts } from "../../../orchestration/models/types.ts";
import { resolveEngineRouting, routeEngine, routeEngineForHost, type EngineRouteOptions, type HostRouteOptions } from "../routing.ts";
import type { EngineRouteResult } from "../routing.ts";

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
      maxTurns: false,
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
    run: (_t: AgentCallOpts, _c: RunContext) => Promise.reject(new Error("fake: run not implemented")),
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
  /** 额外注册第三引擎（probe ok）——fallback 目标为「非 pi 的其他全局默认」用例。 */
  globalEngine?: string;
}) {
  const engines = new Map<string, EnginePort>();
  engines.set(DEFAULT_ENGINE_ID, makeFakeEngine("pi", true));
  engines.set("zcode", makeFakeEngine("zcode", overrides?.zcodeProbeOk ?? true));
  if (overrides?.globalEngine !== undefined) {
    engines.set(overrides.globalEngine, makeFakeEngine(overrides.globalEngine, true));
  }
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

  it("守卫 b（首期与 a 合流）：能力依赖声明无独立载体，frontmatter 指定（非 call）不阻断 fallback", async () => {
    // [D6 合流] 原 AgentTaskSpec.requires 形状预留已随任务形状合流裁撤（无生产写入方，
    // 见 AgentCallOpts 类型注释）；行为面保持：frontmatter 指定（非 call）+ 无 model
    // → 仍走 fallback（能力依赖声明的独立载体留给将来下钻）
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

  it("frontmatter zcode + config 默认同为 zcode + probe 失败：fallback 回 pi（不回退同一坏引擎）", async () => {
    // review MF3 回归：全局默认 === 请求引擎时，fallback 目标不得 = 刚 probe 失败的
    // 引擎（from==to 原地重试坏引擎 + 误导留痕）——回内置缺省 pi
    const { opts, engines } = makeRoute({
      zcodeProbeOk: false,
      routing: { agentEngine: "zcode", globalDefaultEngine: "zcode" },
    });
    const result = await routeEngine(opts);
    expect(result.engine).toBe(engines.get("pi"));
    expect(result.engineId).toBe("pi");
    expect(result.requestedEngineId).toBe("zcode");
    expect(result.engineFallback).toEqual({ from: "zcode", reason: "engine_probe_failed" });
  });

  it("frontmatter zcode + config 默认为其他引擎：probe 失败回全局默认（既有行为不回归）", async () => {
    // 全局默认 ≠ 请求引擎且非 pi：fallback 目标仍是全局默认（相等比较只拦截 from==to 形态）
    const { opts, engines } = makeRoute({
      zcodeProbeOk: false,
      globalEngine: "claude",
      routing: { agentEngine: "zcode", globalDefaultEngine: "claude" },
    });
    const result = await routeEngine(opts);
    expect(result.engine).toBe(engines.get("claude"));
    expect(result.engineId).toBe("claude");
    expect(result.engineFallback).toEqual({ from: "zcode", reason: "engine_probe_failed" });
  });
});

// ============================================================
// routeEngineForHost（D3-② 路由单点：宿主两调用点的统一编排）
// ============================================================

describe("routeEngineForHost：宿主统一路由（D3-②）", () => {
  /** 本地 pi 引擎实例替身（chat 域 = chatPiEngine / workflow 域 = SAR per-session DI）。 */
  function makeLocalPi(): EnginePort {
    return makeFakeEngine("local-pi", true);
  }

  /** 装配 host 路由参数（registry 面复用 makeRoute 的注入件）。 */
  function makeHostRoute(overrides?: Parameters<typeof makeRoute>[0]): {
    hostOpts: HostRouteOptions;
    probeCalls: string[];
    engines: Map<string, EnginePort>;
    piEngine: EnginePort;
  } {
    const { opts, probeCalls, engines } = makeRoute(overrides);
    const piEngine = makeLocalPi();
    const { routing, ...rest } = opts;
    return { hostOpts: { ...rest, routing: routing ?? {}, piEngine }, probeCalls, engines, piEngine };
  }

  it("pi 请求（缺省）：同步短路——返回值不是 Promise（零微任务，缺省路径时序契约）且免探", () => {
    const { hostOpts, piEngine, probeCalls } = makeHostRoute();
    const routed = routeEngineForHost(hostOpts);
    expect(routed).not.toBeInstanceOf(Promise);
    const route = routed as EngineRouteResult;
    expect(route.engine).toBe(piEngine); // 本地 pi 实例接管，不经 registry
    expect(route.engineId).toBe("pi");
    expect(route.source).toBe("default");
    expect(probeCalls).toEqual([]); // pi 免探（D7 轻量口径，缺省路径零 probe 开销）
  });

  it("显式 engine='pi'：同步短路同形（call source 留痕）", () => {
    const { hostOpts, piEngine } = makeHostRoute({ routing: { callEngine: "pi" } });
    const routed = routeEngineForHost(hostOpts);
    expect(routed).not.toBeInstanceOf(Promise);
    const route = routed as EngineRouteResult;
    expect(route.engine).toBe(piEngine);
    expect(route.source).toBe("call");
  });

  it("非 pi 请求（frontmatter zcode + probe ok）：返回 Promise，resolve 经注入获取引擎", async () => {
    const { hostOpts, engines } = makeHostRoute({ routing: { agentEngine: "zcode" } });
    const routed = routeEngineForHost(hostOpts);
    expect(routed).toBeInstanceOf(Promise);
    const route = await routed;
    expect(route.engine).toBe(engines.get("zcode"));
    expect(route.engineId).toBe("zcode");
  });

  it("probe 失败兜底回 pi：本地 pi 实例接管（不依赖 registry 的 pi 注册态）+ fallback 留痕", async () => {
    const { hostOpts, piEngine } = makeHostRoute({
      zcodeProbeOk: false,
      routing: { agentEngine: "zcode" },
    });
    const route = await routeEngineForHost(hostOpts);
    expect(route.engine).toBe(piEngine);
    expect(route.engineId).toBe("pi");
    expect(route.requestedEngineId).toBe("zcode");
    expect(route.engineFallback).toEqual({ from: "zcode", reason: "engine_probe_failed" });
  });

  it("registry 面未注册 pi：兜底/清单两口径都不把本地 pi 漏报（SAR 单测 mock 形态）", async () => {
    // registry 面只含 zcode（probe 失败）——模拟「本地 pi 不在全局注册表」的注入形态
    const engines = new Map<string, EnginePort>([["zcode", makeFakeEngine("zcode", false)]]);
    const probeCalls: string[] = [];
    const piEngine = makeLocalPi();
    const mkOpts = (): HostRouteOptions => ({
      routing: { agentEngine: "zcode" },
      strict: false,
      probe: (id) => {
        probeCalls.push(id);
        return engines.get(id)!.probe();
      },
      piEngine,
      getEngineFn: (id) => {
        const e = engines.get(id);
        if (e === undefined) throw new EngineNotFoundError(id, [...engines.keys()]);
        return e;
      },
      hasEngineFn: (id) => engines.has(id),
      listEnginesFn: () => [...engines.keys()],
    });
    // probe 失败 + 无守卫 → 兜底回 pi：本地实例接管，不触 registry 的 pi 缺失
    const route = await routeEngineForHost(mkOpts());
    expect(route.engine).toBe(piEngine);
    expect(route.engineId).toBe("pi");
    expect(probeCalls).toEqual(["zcode"]);
    // 未注册 id：engine_not_found 文案清单含 pi（本地 pi 恒可用，不漏报）
    const ghostOpts: HostRouteOptions = {
      ...mkOpts(),
      routing: { callEngine: "ghost" },
    };
    const err = await routeEngineForHost(ghostOpts).then(
      (r) => r,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("engine_not_found");
    expect((err as EngineNotFoundError).registered).toContain("pi");
  });
});
