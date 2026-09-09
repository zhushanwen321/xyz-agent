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
import { EngineNotFoundError, getEngine, hasEngine, listEngines } from "../registry.ts";
import { PI_POOL_KEY, PiEngine } from "../engines/pi/pi-engine.ts";
import type { PiEngineService } from "../engines/pi/pi-engine.ts";

// inproc 过渡残余的契约类型 re-export（W7 迁 pi包 / W11 删）：subagent-service 经本面
// 取类型，不直接触达 engines/pi 路径。
export type { ChatRoundTicket, PiEngine, PiEngineService } from "../engines/pi/pi-engine.ts";
export { PI_POOL_KEY };

// [W11] runSpawn / SessionRunnerContext / SpawnResumeOpts / resetAllEpipeFailures /
// maxTurnsToWatchdogMs：归属物已迁 @zhushanwen/pi-subagent-cli（spawn-runner 等
// 等价物）；core 侧**chat 域 inproc 保留面**（主 agent 裁决 2026-09：chat 续聊的
// v1 协议载荷面缺口，协议 v1.x 扩展待排期——临时豁免，非永久内置）继续消费
// engines/pi 原件，消费点（subagent-service / barrel）的 import 收敛到本公共面。
// 深路径 import 只剩本文件与 spawned-children.ts 两个 host 桥（豁免面最小化）。
export { runSpawn } from "../engines/pi/session-runner.ts";
export type { SessionRunnerContext, SpawnResumeOpts } from "../engines/pi/session-runner.ts";
export { resetAllEpipeFailures } from "../engines/pi/stdin-writer.ts";
export { maxTurnsToWatchdogMs } from "../engines/pi/session-runner.ts";

/**
 * chat 域 pi 引擎构造（inproc 保留面，[W11 主 agent 裁决] 临时豁免）：per-service
 * DI 绑定保持——getService 经适配器绑本 Service 实例（registry 全局 'pi' 单例绑进程级
 * getSubagentService()，直构 Service 的测试场景解析不到本实例）。cli 形态 chat 接线
 * 待协议 v1.x 扩展 chat 载荷面后收口（非永久内置）。
 */
export function createChatPiEngine(getService: () => PiEngineService | null): PiEngine {
  return new PiEngine({ getService });
}

/**
 * 宿主侧 pi EnginePort 解析（SAR）：registry 的 'pi' 已注册 **cli 形态** port
 * （发现器装载的 RemoteEngine）时经 descriptor 路由（getEngine——惰性单例 + 两形态
 * 透明）；注册的是 inproc pi（宿主/测试显式 registerEngine）→ per-session DI 重绑
 * （mock 注入语义不取 registry 单例）。
 * [U-2 一致性修复] pi **未注册**（引擎包未装/发现失败）时不再静默直构 inproc 实例——
 * 那会把 chat 域临时豁免面扩大到普通 run 路径，并吞掉设计 D4「全不可用 → 派发期
 * engine_not_found + 安装指引」错误契约（zcode 侧 d8-compat 已是显式报错，两引擎
 * 语义对称）。返回不可用 stub：路由层对 pi 恒同步短路（本地 pi 恒可用口径），真正的
 * 拒绝发生在首次 engine.run——stub 抛 EngineNotFoundError（含安装指引），由 SAR
 * 「不 reject」契约收口进 result.error。
 */
export function resolveHostPiEnginePort(getService: () => PiEngineService | null): EnginePort {
  if (hasEngine("pi")) {
    const port = getEngine("pi");
    if (!(port instanceof PiEngine)) return port;
    return createChatPiEngine(getService);
  }
  return piUnavailableEnginePort();
}

/** pi 不可用 stub（D4）：一切执行面抛 engine_not_found；capabilities 全放行（拒绝点唯一化在 run）。 */
function piUnavailableEnginePort(): EnginePort {
  const fail = (): never => {
    throw new EngineNotFoundError("pi", listEngines());
  };
  return {
    id: "pi",
    capabilities: () => ({
      schemaEnforcement: "native",
      steer: "native",
      conversation: "native",
      personaInjection: "file",
      eventGranularity: "stream",
      sandbox: "none",
      sessionRead: "full",
      resume: "native",
      interrupt: "native",
      permissionMode: "native",
      maxTurns: true,
    }),
    probe: () => fail(),
    run: () => fail(),
    interact: () => fail(),
    read: () => fail(),
  };
}
