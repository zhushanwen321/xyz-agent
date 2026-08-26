// src/execution/engine/engines/pi/registration.ts
//
// pi 引擎注册入口（P1 接线）。设计权威源：§3.3.1（注册表 id → factory）+ D9（缺省
// 引擎 = 'pi'）。组合根（src/index.ts 扩展初始化）调用 registerPiEngine()，把进程级
// SubagentService 单例登记为 registry 里的 'pi' 引擎——此后引擎获取统一经
// getEngine('pi') / getEngine(DEFAULT_ENGINE_ID)，上层不再硬编码「spawn pi」这一选择。
//
// 为什么独立文件：pi-engine.ts 保持零注册副作用（被 SAR 等 DI 场景 import 时只拿类），
// 注册是组合根的职责——依赖方向 registry ← registration ← pi-engine 单向，无循环。

import { getSubagentService } from "../../../subagent-service.ts";
import { registerEngine } from "../../registry.ts";
import { PI_ENGINE_ID, PiEngine } from "./pi-engine.ts";
import type { PiEngineService } from "./pi-engine.ts";

export { PI_ADAPTER_VERSION, PI_ENGINE_ID, PI_POOL_KEY, PiEngine } from "./pi-engine.ts";
export type { PiEngineDeps, PiEngineService } from "./pi-engine.ts";

/**
 * 构造绑定到指定服务定位器的 PiEngine（DI 工厂）。
 * SAR（per-session DI 构造，注入 mock 的测试场景）用本工厂绑定自身持有的服务引用；
 * registry 全局单例绑定的是进程级 getSubagentService()——生产环境两者是同一对象。
 */
export function createPiEngine(getService: () => PiEngineService | null): PiEngine {
  return new PiEngine({ getService });
}

/**
 * 把 'pi' 引擎登记进 registry（幂等——组合根可能多次执行，如每次 session_start）。
 * 工厂绑进程单例 getSubagentService：惰性求值，session_start 注入前调用 getEngine
 * 只会拿到引擎实例，真正 run 时才解析服务。
 */
export function registerPiEngine(): void {
  registerEngine(PI_ENGINE_ID, () => createPiEngine(getSubagentService));
}
