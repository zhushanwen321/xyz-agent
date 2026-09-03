// src/execution/engine/engines/pi/reader.ts
//
// PiEngine reader（P5）：pi subagent session JSONL → SessionView（设计 D6 read
// 降级链第①级的 pi 侧实现）。
//
// 双端复用约束（设计 §3.3.7，与 zcode/reader.ts 同款）：本模块必须保持无状态
// 纯函数、无 spawn/进程依赖、不 import 同包 launcher/preparer/parser。因此
// PI_ENGINE_ID 在此本地锚定（pi-engine.ts 的同名常量会连带运行时件 import，
// 破坏「共享 reader 是唯一允许被 xyz-agent runtime import 的引擎模块」约束）。
//
// 下沉说明（A1 守护）：turns 重建逻辑本体 = session-reconstructor.reconstructFromFile
// （pi JSONL → ReconstructedRecord，extension 侧唯一 source of truth）。本模块只做
// ReconstructedRecord → SessionView 的投影（投影原语 toReplayedTurn / aggregateUsage
// 收敛在 common/session-view-projection.ts 单一实现），不改 reconstructor 本体——
// pi 现有直读行为零变化。
//
// xyz-agent runtime 侧的 pi 历史读取链（getHistoryFromFilePath）是独立实现（shared
// Message 投影），不消费本模块——两链各自保持现状（P5 只对非 pi 引擎引入共享
// reader；pi 的 runtime 链路回归由现有测试守护）。
//
// [D2 实施期门②裁决：保留（2026-09-02，u-2a）] 现状 readPiSessionView 仅被
// PiEngine.read（①级原生层）消费、read 面生产零调用（pi 历史走 runtime 自有 JSONL
// 直读链）——但 EnginePort.read 是四能力面的非可选成员（port.ts），pi 的
// capabilities.sessionRead='full' 与 conformance read 降级契约（contract.read-
// degradation）以此为①级实现；删除本模块会使 pi 的 read 面空心化（②③级兜底直通），
// 与终态图（dual-track-convergence §3.5：engines/pi/ 四件套含 reader）矛盾。保留
// 不构成第三个 SessionView 装配实现：u-1a 的 session-view-service（GUI 生产链）对
// pi 分支维持防御性空返回（A1 守护，不 import 本模块），两链零交叠；read 面的
// 生产调用方归属终态「extension 内 EnginePort.read() 复用同一 module」接线
// （§3.5 GUI 读取路径），不在 u-2a 范围。

import { reconstructFromFile } from "../../../session-reconstructor.ts";
import type { SessionView } from "../../types.ts";
import { aggregateUsage, toReplayedTurn } from "../../common/session-view-projection.ts";

/** pi 引擎的 registry key（与 engines/pi/pi-engine.ts 的 PI_ENGINE_ID 同值锚定）。 */
export const PI_ENGINE_ID = "pi";

/**
 * 读取 pi subagent session 的引擎中立视图（read 第①级）。
 *
 * @param sessionFile pi session JSONL 绝对路径
 * @returns undefined = 文件缺失/损坏/缺 identity entry/无 assistant message
 *          （reconstructFromFile 的降级语义，不 throw——降级链由宿主编排）。
 */
export async function readPiSessionView(sessionFile: string): Promise<SessionView | undefined> {
  const recon = reconstructFromFile(sessionFile);
  if (recon === undefined) return undefined;
  const usage = aggregateUsage(recon.turns);
  return {
    engineId: PI_ENGINE_ID,
    // recon.id 是 subagent record id——pi 链路的 sessionId 约定即 header id 兜底
    // record.id（collectResult 同源，与 pi-engine read 的既有约定一致）
    sessionId: recon.id,
    turns: recon.turns.map(toReplayedTurn),
    ...(usage !== undefined ? { usage } : {}),
    source: "native",
  };
}
