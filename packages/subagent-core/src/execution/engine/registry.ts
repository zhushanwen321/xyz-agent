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
// （core/logger 是 facade 基础设施非引擎，dispose best-effort 记日志需要它，不违反本纪律。）

import { getLogger } from "../../core/logger.ts";

import type { EnginePort } from "./port.ts";

// core log facade（execution 层统一 "subagents" component，模块顶层缓存惯例）。
const logger = getLogger("subagents");

/** 引擎工厂：惰性创建引擎实例（getEngine 首次取用时执行）。 */
export type EngineFactory = () => EnginePort;

/**
 * 缺省引擎 id（D9：缺省引擎 = 'pi'，回填期零风险默认）。
 * P1 无 per-agent/调用级 engine 字段（P4 配置路由引入三层优先级），一切执行恒走缺省。
 */
export const DEFAULT_ENGINE_ID = "pi";

/**
 * defaultEngine 缺省归一（单一权威源）：空白 / undefined 归一到缺省引擎（'pi'）。
 * 引擎感知检测 diff 与状态段渲染必须对同一读取结果给出同一引擎 id——若两处各自
 * 内联归一，一致性只靠注释人工耦合，漂移即两处说谎；故收敛到本函数供各处调用。
 * sanitize 保证透传值非空，但可能带首尾空格，故 trim 后再判。
 */
export function normalizeEngineId(engine: string | undefined): string {
  return engine?.trim() || DEFAULT_ENGINE_ID;
}

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
  /** 错误来源定位（agent .md 文件路径 / 配置键等；运行期 getEngine 无来源不传）。 */
  readonly source: string | undefined;

  constructor(engineId: string, registered: readonly string[], source?: string) {
    super(
      `engine_not_found: engine '${engineId}' is not registered. ` +
        `Registered engines: ${registered.length > 0 ? registered.join(", ") : "(none)"}. ` +
        `Recovery: check the engine id in the agent .md frontmatter (engine: field) or the global ` +
        `default engine setting, fix the typo, or install/register the engine first ` +
        `(registered engines are listed above).` +
        (source !== undefined ? ` Source: ${source}.` : ""),
    );
    this.name = "EngineNotFoundError";
    this.engineId = engineId;
    this.registered = registered;
    this.source = source;
  }
}

/**
 * id → factory（注册表本体）+ id → 惰性单例（getEngine 首次取用创建；registerEngine
 * 覆盖时丢弃旧实例）。进程级单例状态，用 globalThis[Symbol.for] 持有防 jiti 双路径
 * 加载分裂（development-guide §7.5），不用模块级 const。
 */
const ENGINE_REGISTRY_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagent-workflow.engineRegistry");

/** 注册表槽位形状（同文件唯一写入点，运行时保证）。 */
interface EngineRegistrySlot {
  factories: Map<string, EngineFactory>;
  singletons: Map<string, EnginePort>;
}

function getRegistrySlot(): EngineRegistrySlot {
  // globalThis 无 symbol 索引签名，但运行时支持 symbol 键——用 Reflect 安全读写，
  // 避免双重断言（同 model-config-service.ts 先例）。
  let slot = Reflect.get(globalThis, ENGINE_REGISTRY_SLOT_KEY) as EngineRegistrySlot | undefined;
  if (!slot) {
    slot = { factories: new Map(), singletons: new Map() };
    Reflect.set(globalThis, ENGINE_REGISTRY_SLOT_KEY, slot);
  }
  return slot;
}

/**
 * [R1 D6] 触发引擎 dispose：同步调用拿 Promise 不 await（「触发不等待」，D6①——
 * dispose 的同步面〔fire close 帧 + 同步 SIGTERM〕由引擎实现保证在返回 Promise 前
 * 完成，registry 不等待异步段）。同步 throw 与异步 reject 均记日志吞掉，绝不外溢
 * 阻断调用方——重注册替换（D6②）与宿主收割（D6③）都是 best-effort 面，且 reject
 * 无人接会成为 unhandledRejection 崩宿主。两条 dispose 路径共用本函数。
 */
function triggerEngineDispose(engine: EnginePort, source: string): void {
  if (typeof engine.dispose !== "function") return;
  try {
    engine.dispose().then(undefined, (err: unknown) => {
      logger.warn(
        `[engine-registry] engine '${engine.id}' dispose rejected (${source}, best-effort continue): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  } catch (err) {
    logger.warn(
      `[engine-registry] engine '${engine.id}' dispose threw synchronously (${source}, best-effort continue): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * 登记引擎工厂。重复注册同一 id = 覆盖（组合根可能多次执行，如每次 session_start 重跑
 * registerPiEngine——幂等覆盖保证不炸也不堆积），覆盖时丢弃缓存的旧单例，让下一次
 * getEngine 用新工厂重建。
 *
 * [R1 D6②] 覆盖前对已实例化的旧单例触发 dispose（防泄漏——旧实例可能持有常驻进程/
 * 长连接）；触发不等待 + 失败不阻断（见 triggerEngineDispose），幂等覆盖语义不变。
 */
export function registerEngine(id: string, factory: EngineFactory): void {
  const slot = getRegistrySlot();
  const previous = slot.singletons.get(id);
  if (previous) triggerEngineDispose(previous, `registerEngine('${id}') overwrite`);
  slot.factories.set(id, factory);
  slot.singletons.delete(id);
}

/**
 * [R1 D6③] 对已实例化的引擎单例触发 dispose（触发不等待）。宿主唯一收割入口
 * （session-runner killAllSpawnedChildren）在杀 per-record children 之前调用——
 * 常驻进程的回收归引擎 dispose，本函数只负责按序触发。
 *
 * 只遍历 singletons：已实例化才可能持有常驻资源，绝不经 getEngine 实例化未用
 * 引擎（停机路径反向创建资源违背停机语义）。dispose 后不删单例——幂等与
 * 「dispose 后首个 run 自动重建」由引擎实现承诺（§3.4 不变量 4），registry
 * 不越权管理引擎内部生命周期。
 */
export function disposeEngines(): void {
  for (const engine of getRegistrySlot().singletons.values()) {
    triggerEngineDispose(engine, "disposeEngines()");
  }
}

/** 未注册 id 抛 EngineNotFoundError（含已注册清单与配置指引）。 */
export function getEngine(id: string): EnginePort {
  const slot = getRegistrySlot();
  const cached = slot.singletons.get(id);
  if (cached) return cached;
  const factory = slot.factories.get(id);
  if (!factory) {
    throw new EngineNotFoundError(id, listEngines());
  }
  const engine = factory();
  slot.singletons.set(id, engine);
  return engine;
}

/** id 是否已注册（agent 解析期的配置校验入口，D9——不取实例、不触发工厂副作用）。 */
export function hasEngine(id: string): boolean {
  return getRegistrySlot().factories.has(id);
}

/** 已注册引擎 id 清单（稳定序 = 注册序；错误文案与 GUI 引擎选择器共用）。 */
export function listEngines(): string[] {
  return [...getRegistrySlot().factories.keys()];
}

/**
 * 清空注册表（测试隔离专用：防止用例间工厂/单例泄漏串扰）。
 * 生产代码禁用——进程内注册表是全局状态，清空会让已获取的引擎句柄与新注册表脱钩。
 */
export function clearEngines(): void {
  const slot = getRegistrySlot();
  slot.factories.clear();
  slot.singletons.clear();
}
