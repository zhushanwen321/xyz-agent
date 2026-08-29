// src/execution/engine/engines/zcode/registration.ts
//
// zcode 引擎注册入口（P3 接线）。与 pi/registration.ts 同构：zcode-engine.ts 保持零
// 注册副作用，注册是组合根（src/index.ts）的职责——依赖方向 registry ← registration
// ← zcode-engine 单向，无循环。
//
// engineDataDir 通道：默认走公共 data-dir SSOT（common/data-dir.ts——env
// XYZ_AGENT_DATA_DIR（xyz-agent 宿主注入）→ piAgentDir 回退 + warn，透传链证据见该
// 文件头）。组合根可显式传 getter 覆盖（测试 / 宿主 DI）。

import { getEngineDataDir } from "../../common/data-dir.ts";
import { registerEngine } from "../../registry.ts";
import { ZCODE_ENGINE_ID } from "./constants.ts";
import { ZcodeEngine } from "./zcode-engine.ts";
import type { ZcodeEngineDeps } from "./zcode-engine.ts";

export { ZCODE_ADAPTER_VERSION, ZCODE_ENGINE_ID } from "./constants.ts";
export { ZcodeEngine } from "./zcode-engine.ts";
export type { ZcodeEngineDeps } from "./zcode-engine.ts";

/** 构造 ZcodeEngine（DI 工厂——测试/宿主注入 deps）。 */
export function createZcodeEngine(deps: ZcodeEngineDeps): ZcodeEngine {
  return new ZcodeEngine(deps);
}

/**
 * 把 'zcode' 引擎登记进 registry（幂等——组合根可能多次执行，registerEngine 覆盖
 * 语义）。工厂惰性：登记不触发任何文件/进程探测，首次 getEngine 才建实例。
 */
export function registerZcodeEngine(engineDataDir: () => string = getEngineDataDir): void {
  registerEngine(ZCODE_ENGINE_ID, () =>
    createZcodeEngine({
      engineDataDir,
      ...(process.env["XYZ_ZCODE_CLI"] !== undefined ? { cliPath: process.env["XYZ_ZCODE_CLI"] } : {}),
    }),
  );
}
