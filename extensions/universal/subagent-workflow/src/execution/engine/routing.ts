// src/execution/engine/routing.ts
//
// 配置路由与探针 fallback 编排（P4）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D9（配置路由三层 + 故障 fallback
// 三守卫 + model/engine 正交 + workflow 脚本不写死 engine）+ D7（探针分级与触发时机）
// + §3.3.3 错误规格（engine_probe_failed / model_not_available 行）。
//
// 职责边界：本模块只做「选哪个引擎」的决策（纯路由 + probe 编排），不 spawn、不读
// 任务正文。三层优先级与守卫的判定规则集中于此单一权威点——上层（SAR）只消费
// routeEngine 的结果，散落的 if engine === ... 分派被结构性排除。
//
// probe 触发时机（D7「引擎 factory 初始化与版本变化检测时触发」的 P4 落地口径）：
// 路由期触发、结果缓存于引擎实例（probeCache）。缺省引擎 'pi' 免探——pi 契约稳定
// （rpc.md 官方，D7 稳定性光谱的轻探针端）且「缺省路径行为零变化」是 A1 硬约束
// （每次 run 前强探会引入 pi --version 子进程开销与新的失败面）；显式 engine='pi'
// 同样免探（fallback 无处可去，守卫 a 对 pi 不可达是自然结果而非缺口）。进程存活
// 期间缓存不失效——版本变化（运行中 CLI 被升级）由 engine_run_failed 运行中兜底
// （D11 规则②封边界的既有设计），重启进程 / registerEngine 覆盖后重探。

import { EngineError } from "./common/errors.ts";
import type { EnginePort } from "./port.ts";
import { DEFAULT_ENGINE_ID, EngineNotFoundError, getEngine, hasEngine, listEngines } from "./registry.ts";
import type { ProbeReport } from "./types.ts";

// ============================================================
// 三层优先级（D9）
// ============================================================

/** 三层路由的输入（各层值由调用方装配；undefined = 该层不指定）。 */
export interface EngineRoutingInput {
  /** 第一层：调用参数 engine（workflow step 级 / AgentCallOpts.engine）。 */
  callEngine?: string;
  /** 第二层：agent .md frontmatter engine（解析期已对注册表校验）。 */
  agentEngine?: string;
  /** 第三层：全局默认引擎（config.json defaultEngine；缺省 'pi'）。 */
  globalDefaultEngine?: string;
}

/** 生效层标记（守卫 a 的判据：'call' = 显式指定，probe 失败不兜底）。 */
export type EngineRoutingSource = "call" | "frontmatter" | "default";

export interface EngineRouting {
  engineId: string;
  source: EngineRoutingSource;
}

/**
 * 纯三层解析：调用参数 > agent frontmatter > 全局默认（缺省 'pi'）。
 * 不校验注册表（frontmatter 层已前置校验；调用参数层的校验归 routeEngine）——
 * 保持纯函数可独立单测。
 */
export function resolveEngineRouting(input: EngineRoutingInput): EngineRouting {
  if (input.callEngine !== undefined && input.callEngine !== "") {
    return { engineId: input.callEngine, source: "call" };
  }
  if (input.agentEngine !== undefined && input.agentEngine !== "") {
    return { engineId: input.agentEngine, source: "frontmatter" };
  }
  const global = input.globalDefaultEngine;
  if (global !== undefined && global !== "") {
    return { engineId: global, source: "default" };
  }
  return { engineId: DEFAULT_ENGINE_ID, source: "default" };
}

// ============================================================
// routeEngine：probe 编排 + fallback 三守卫（D9①/D7）
// ============================================================

/** routeEngine 的参数（probe/getEngine 注入——测试可 mock，SAR 提供生产实现）。 */
export interface EngineRouteOptions {
  routing: EngineRoutingInput;
  /**
   * 显式 model（守卫 c 判据：model 与引擎 provider 体系绑定，D9②）。短名 model 的
   * provider 缺省决策在 zcode preparer 的 defaultProviderForShortName——显式默认引擎
   * 模型配置（config.json per-engine model）引入时，两处须同步让位配置值优先
   * （对齐点⑦，详见 preparer.ts 该函数注释）。
   */
  taskModel?: string;
  /** engineRouting.strict（config.json）：true = 一切 probe 失败直接报错。 */
  strict: boolean;
  /** 探针执行体（返回 ProbeReport；引擎实例内部有缓存语义）。 */
  probe: (engineId: string) => Promise<ProbeReport>;
  /** 引擎获取（缺省 registry.getEngine；测试/SAR 可注入）。 */
  getEngineFn?: (engineId: string) => EnginePort;
  /** 注册表存在性检查（缺省 registry.hasEngine）。 */
  hasEngineFn?: (engineId: string) => boolean;
  /** 注册表清单（缺省 registry.listEngines——engine_not_found 文案的数据源）。 */
  listEnginesFn?: () => string[];
}

export interface EngineRouteResult {
  engine: EnginePort;
  /** 实际执行引擎 id（fallback 后可能 ≠ 请求值）。 */
  engineId: string;
  /** 路由决策时的请求引擎 id（fallback 留痕的 from 值）。 */
  requestedEngineId: string;
  /** 生效层（守卫 a 判据的留痕）。 */
  source: EngineRoutingSource;
  /** fallback 留痕（record/outcome 投影，GUI 警告条数据源）。无 fallback 缺省。 */
  engineFallback?: { from: string; reason: string };
}

/**
 * 路由 + 探针 + fallback 编排（SAR run 入口调用）。
 *
 * 失败形态（全部抛结构化错误，调用方转 AgentResult.error）：
 *   - 未注册 id（调用参数层漏网）：EngineNotFoundError（engine_not_found）
 *   - strict 或守卫命中：EngineError(engine_probe_failed)
 *   - 守卫 c（显式 model + 将换引擎）：EngineError(model_not_available)
 */
export async function routeEngine(opts: EngineRouteOptions): Promise<EngineRouteResult> {
  const has = opts.hasEngineFn ?? hasEngine;
  const get = opts.getEngineFn ?? getEngine;
  const routing = resolveEngineRouting(opts.routing);

  // 调用参数层的注册表校验（frontmatter 层已在 agent 解析期抛过；这里兜调用参数
  // 直传的未注册 id——错误含注册清单，配置错误前置到路由期而非 getEngine 深处）
  if (!has(routing.engineId)) {
    throw new EngineNotFoundError(routing.engineId, opts.listEnginesFn?.() ?? listEngines(), describeRoutingSource(opts.routing));
  }

  // 缺省引擎免探（见文件头「probe 触发时机」）——直接取引擎
  if (routing.engineId === DEFAULT_ENGINE_ID) {
    return {
      engine: get(routing.engineId),
      engineId: routing.engineId,
      requestedEngineId: routing.engineId,
      source: routing.source,
    };
  }

  const report = await opts.probe(routing.engineId);
  if (report.ok) {
    return {
      engine: get(routing.engineId),
      engineId: routing.engineId,
      requestedEngineId: routing.engineId,
      source: routing.source,
    };
  }

  // ── probe 失败：strict / 三守卫 / fallback（D9①）──
  if (opts.strict) {
    throw probeFailedError(routing.engineId, report, "engineRouting.strict=true：probe 失败一律报错（不 fallback）");
  }
  // 守卫 a/b（首期合流）：显式指定（调用参数或 step 级）= 能力依赖声明，静默换引擎
  // 违反意图——沙箱类任务被静默卸除安全能力正是要防的形态（D9① 原文）。守卫 b 的
  // 独立载体（AgentTaskSpec.requires）下钻后在本分支前独立判定，首期显式 engine 即声明。
  if (routing.source === "call") {
    throw probeFailedError(routing.engineId, report, "engine 来自调用参数显式指定（能力依赖声明）——不兜底");
  }

  const fallbackId = fallbackTargetId(opts.routing, routing.source);
  // 守卫 c：显式 model 与引擎 provider 体系绑定（D9② model/engine 正交）——换引擎
  // 后 model 可解析性无法保证，静默换引擎跑 = 「以为用了 X 实际用 Y」。判定取保守
  // 口径（显式 model + 引擎切换即拒）：路由层无各引擎 provider 注册表的访问面，
  // 精确可解析性判定归引擎 prepare 期（ZcodePrepareError.model_not_available 已有）。
  if (opts.taskModel !== undefined && opts.taskModel !== "" && fallbackId !== routing.engineId) {
    throw new EngineError(
      "model_not_available",
      `engine '${routing.engineId}' probe 失败且任务显式指定 model '${opts.taskModel}'——model 与引擎 provider 体系绑定，换引擎（fallback 到 '${fallbackId}'）不静默执行`,
      `修复 engine '${routing.engineId}' 的探针失败（见上方恢复指引）后重试，或去掉 model 指定 / 显式传 engine: '${fallbackId}' 确认模型可用后再派发`,
    );
  }

  return {
    engine: get(fallbackId),
    engineId: fallbackId,
    requestedEngineId: routing.engineId,
    source: "default",
    engineFallback: { from: routing.engineId, reason: "engine_probe_failed" },
  };
}

/**
 * fallback 目标：请求来自 frontmatter/调用参数 → 全局默认引擎；请求即全局默认
 * （defaultEngine 配了坏引擎，source='default'）→ 内置缺省 'pi'（零风险回退——设计
 * 终态四口径：fallback 回「缺省 pi」而非原地重试坏引擎）。
 */
function fallbackTargetId(routing: EngineRoutingInput, source: EngineRoutingSource): string {
  if (source === "default") return DEFAULT_ENGINE_ID;
  const global = routing.globalDefaultEngine;
  if (global !== undefined && global !== "" && global !== DEFAULT_ENGINE_ID) {
    return global;
  }
  return DEFAULT_ENGINE_ID;
}

/** engine_probe_failed 的结构化构造（detail 含逐 check 摘要，recovery 用探针产出）。 */
function probeFailedError(engineId: string, report: ProbeReport, guard: string): EngineError {
  const checks = report.checks.map((c) => `${c.name}:${c.ok ? "ok" : "FAIL"}`).join(", ");
  return new EngineError(
    "engine_probe_failed",
    `engine '${engineId}' probe 失败（${guard}）。checks: [${checks}]`,
    report.error?.recovery ??
      `Confirm the engine binary and version, then re-run the probe (probe({force:true}) or re-initialize the engine).`,
  );
}

/** 路由来源描述（EngineNotFoundError 的 source 定位）。 */
function describeRoutingSource(routing: EngineRoutingInput): string | undefined {
  if (routing.callEngine !== undefined && routing.callEngine !== "") {
    return `call parameter engine='${routing.callEngine}'`;
  }
  if (routing.agentEngine !== undefined && routing.agentEngine !== "") {
    return `agent frontmatter engine='${routing.agentEngine}'`;
  }
  return undefined;
}
