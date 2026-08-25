// src/execution/engine/registry.ts
//
// 引擎注册表（P1）。设计权威源：docs/architecture/subagent-engine-abstraction.md
// §3.3.1 分层总图（[引擎注册表 engine registry]（id → factory））与 §3.3.3 错误规格
// 第 1 行（engine_not_found → 指向注册表清单 + 配置文件路径）。
//
// 为什么需要注册表：引擎身份是「spawn 细节的归属边界」（设计 §2.3 根因一）——上层
// （配置路由/agent 解析，P4 接线）按 id 取引擎，不感知实现类；新引擎接入 = 新增一个
// 适配器模块 + 注册表登记一行，不改上层与既有引擎（目标 5）。
//
// 依赖方向（设计 §3.3.1 贯穿纪律④）：registry 只依赖 port.ts 的类型，不 import 任何
// 具体引擎——注册由组合根（index.ts）或引擎自己的 registration 模块完成，防循环依赖。

import type { EnginePort } from "./port.ts";

/** 引擎工厂：惰性创建引擎实例（getEngine 首次取用时执行）。 */
export type EngineFactory = () => EnginePort;

/**
 * 缺省引擎 id（D9：缺省引擎 = 'pi'，回填期零风险默认）。
 * P1 无 per-agent/调用级 engine 字段（P4 配置路由引入三层优先级），一切执行恒走缺省。
 */
export const DEFAULT_ENGINE_ID = "pi";

/**
 * engine_not_found（错误规格表第 1 行）：agent frontmatter 写了未注册 engine id。
 * 错误文案契约：含已注册引擎清单 + 配置文件指引——配置错误前置暴露（agent 解析期），
 * 不留到运行时神秘失败（设计目标 4）。
 */
export class EngineNotFoundError extends Error {
  /** 结构化错误码（§3.3.3 错误规格表的 code 列，供调用方程序化分流）。 */
  readonly code = "engine_not_found";
  /** 请求的（未注册的）引擎 id。 */
  readonly engineId: string;
  /** 请求时刻的已注册清单快照（防错误对象跨时间读 Map 的失真）。 */
  readonly registered: readonly string[];

  constructor(engineId: string, registered: readonly string[]) {
    super(
      `engine_not_found: engine '${engineId}' is not registered. ` +
        `Registered engines: ${registered.length > 0 ? registered.join(", ") : "(none)"}. ` +
        `Recovery: check the engine id in the agent .md frontmatter (engine: field) or the global ` +
        `default engine setting, fix the typo, or install/register the engine first ` +
        `(registered engines are listed above).`,
    );
    this.name = "EngineNotFoundError";
    this.engineId = engineId;
    this.registered = registered;
  }
}

/** id → factory（注册表本体）。进程级单例状态。 */
const factories = new Map<string, EngineFactory>();

/** id → 惰性单例（getEngine 首次取用创建；registerEngine 覆盖时丢弃旧实例）。 */
const singletons = new Map<string, EnginePort>();

/**
 * 登记引擎工厂。重复注册同一 id = 覆盖（组合根可能多次执行，如每次 session_start 重跑
 * registerPiEngine——幂等覆盖保证不炸也不堆积），覆盖时丢弃缓存的旧单例，让下一次
 * getEngine 用新工厂重建。
 */
export function registerEngine(id: string, factory: EngineFactory): void {
  factories.set(id, factory);
  singletons.delete(id);
}

/** 未注册 id 抛 EngineNotFoundError（含已注册清单与配置指引）。 */
export function getEngine(id: string): EnginePort {
  const cached = singletons.get(id);
  if (cached) return cached;
  const factory = factories.get(id);
  if (!factory) {
    throw new EngineNotFoundError(id, listEngines());
  }
  const engine = factory();
  singletons.set(id, engine);
  return engine;
}

/** id 是否已注册（agent 解析期的配置校验入口，D9——不取实例、不触发工厂副作用）。 */
export function hasEngine(id: string): boolean {
  return factories.has(id);
}

/** 已注册引擎 id 清单（稳定序 = 注册序；错误文案与 GUI 引擎选择器共用）。 */
export function listEngines(): string[] {
  return [...factories.keys()];
}

/**
 * 清空注册表（测试隔离专用：防止用例间工厂/单例泄漏串扰）。
 * 生产代码禁用——进程内注册表是全局状态，清空会让已获取的引擎句柄与新注册表脱钩。
 */
export function clearEngines(): void {
  factories.clear();
  singletons.clear();
}
