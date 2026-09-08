// src/execution/engine/host/pi-host-binding.ts
//
// pi 引擎的宿主侧绑定点（W6，impl-plan §2.6「subagent-service 5 处 import 逐条去向」）。
// 职责 = 把 engines/pi 的构造 / 常量 / 契约类型收敛到本公共面——subagent-service 与
// subprocess-agent-runner 不再深路径 import engines/pi（inproc 过渡残余的深 import
// 全部落在本文件，W7 随包迁移 / W11 删）。
//
// 三个出口：
//   - PI_POOL_KEY 常量（descriptor 公共面过渡形态：W4 descriptor 尚未携带 poolKey
//     字段，registry 扩展不在 W6 领地——W7 引擎包 manifest 落 poolKey 后本 re-export
//     换为 descriptor 读取）；
//   - createChatPiEngine：chat 域 inproc 引擎构造（per-service DI 保持——cli 形态的
//     chat 接线随 W7 pi 外移，本出口在过渡期恒返回 inproc 实例）；
//   - resolveHostPiEnginePort：宿主侧（SAR）pi EnginePort 解析——registry 已注册 cli
//     descriptor 时经 descriptor 路由（W3 双模 getEngine），否则 inproc DI 工厂。

import type { EnginePort } from "../port.ts";
import { getEngine, hasEngine } from "../registry.ts";
import { PI_POOL_KEY, PiEngine } from "../engines/pi/pi-engine.ts";
import type { PiEngineService } from "../engines/pi/pi-engine.ts";

// inproc 过渡残余的契约类型 re-export（W7 迁 pi包 / W11 删）：subagent-service 经本面
// 取类型，不直接触达 engines/pi 路径。
export type { ChatRoundTicket, PiEngine, PiEngineService } from "../engines/pi/pi-engine.ts";
export { PI_POOL_KEY };

// [W7] runSpawn / SessionRunnerContext / SpawnResumeOpts（impl-plan §2.6「随 W7 迁
// pi 包」的 core 侧过渡形态）：归属物已迁 @zhushanwen/pi-subagent-cli（spawn-runner
// 等价物）；core inproc 过渡链路继续消费 engines/pi 原件，消费点（subagent-service）
// 的 import 收敛到本公共面——engines/pi 深路径 import 只剩本文件与 spawned-children.ts
// 过渡桥（W11 删）。EPIPE 兜底（resetAllEpipeFailures）同批收敛（§2.6 :82 行）。
export { runSpawn } from "../engines/pi/session-runner.ts";
export type { SessionRunnerContext, SpawnResumeOpts } from "../engines/pi/session-runner.ts";
export { resetAllEpipeFailures } from "../engines/pi/stdin-writer.ts";

/**
 * chat 域 pi 引擎构造（inproc 过渡形态，W11 删）：per-service DI 绑定保持——getService
 * 经适配器绑本 Service 实例（registry 全局 'pi' 单例绑进程级 getSubagentService()，
 * 直构 Service 的测试场景解析不到本实例；不能 import registration.ts 的注册工厂，
 * 其绑定点是进程单例）。cli 形态（RemoteEngine）的 chat 域接线归 W7。
 */
export function createChatPiEngine(getService: () => PiEngineService | null): PiEngine {
  return new PiEngine({ getService });
}

/**
 * 宿主侧 pi EnginePort 解析（SAR :33 改线落点，R1 MF-5）：registry 的 'pi' 已注册
 * **cli 形态** port（W7+ 引擎包注册的 RemoteEngine）时经 descriptor 路由（getEngine
 * ——惰性单例 + 两形态透明）；inproc / 未注册（迁移期现状）回落 per-session DI 直构，
 * 行为与改线前的 createPiEngine 逐点一致（inproc registry 单例绑进程级服务，会破坏
 * SAR 的 per-session mock 注入语义，故 inproc 形态不取 registry 单例）。
 */
export function resolveHostPiEnginePort(getService: () => PiEngineService | null): EnginePort {
  if (hasEngine("pi")) {
    const port = getEngine("pi");
    if (!(port instanceof PiEngine)) return port;
  }
  return createChatPiEngine(getService);
}
