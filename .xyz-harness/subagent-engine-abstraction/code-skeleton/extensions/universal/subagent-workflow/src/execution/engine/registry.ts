// execution/engine/registry.ts
//
// L3 引擎注册表（id → factory）。新引擎接入 = 一个 engines/<id>/ 模块 + 本文件一行
// 登记 + golden 样本（G5 接入成本递减的结构性来源）。
// 未注册 id 在 agent 解析期报 engine_not_found（配置错误前置暴露，不留到运行时）。

import type { EngineDeps, EngineFactory, EnginePort } from "./port.ts";
import type { EngineErrorShape } from "./types.ts";

const registry = new Map<string, EngineFactory>();

export function registerEngine(id: string, factory: EngineFactory): void {
  registry.set(id, factory);
}

export function getEngineFactory(id: string): EngineFactory | undefined {
  return registry.get(id);
}

export function listEngineIds(): string[] {
  return [...registry.keys()];
}

/** 注册表内不存在 → engine_not_found（错误指向注册表清单 + 配置文件路径，§3.3.3）。 */
export function notFoundError(id: string, knownIds: readonly string[]): EngineErrorShape {
  return {
    code: "engine_not_found",
    message: `engine "${id}" is not registered`,
    recovery: `已注册引擎：${knownIds.join(", ")}。检查 agent .md frontmatter 的 engine 字段或全局默认配置（${"{configPath}"}）`,
  };
}

/** 创建引擎实例（接线：真调 factory）。未注册 → throw（由 agent 解析期消费 notFoundError 前置校验）。 */
export function createEngine(id: string, deps: EngineDeps): EnginePort {
  const factory = getEngineFactory(id);
  if (!factory) {
    throw new Error(`engine_not_found: ${id} (registered: ${listEngineIds().join(", ")})`);
  }
  return factory(deps);
}

// ============================================================
// 内置引擎登记（P1/P3 后：pi 回填 + zcode 新增）
// ============================================================

import { createPiEngine } from "./engines/pi/index.ts";
import { createZcodeEngine } from "./engines/zcode/index.ts";

/**
 * 进程启动时调用一次（幂等）。新引擎接入在此追加一行 + engines/<id>/ 模块。
 * 接线：真调 registerEngine（登记链在代码里真实可达）。
 */
export function registerBuiltinEngines(): void {
  if (registry.has("pi")) return;
  registerEngine("pi", createPiEngine);
  registerEngine("zcode", createZcodeEngine);
}
