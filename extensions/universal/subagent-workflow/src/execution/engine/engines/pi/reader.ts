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
// ReconstructedRecord → SessionView 的投影（InternalToolCall strip _status、usage
// 聚合、closed 恒 true），不改 reconstructor 本体——pi 现有直读行为零变化。
//
// xyz-agent runtime 侧的 pi 历史读取链（getHistoryFromFilePath）是独立实现（shared
// Message 投影），不消费本模块——两链各自保持现状（P5 只对非 pi 引擎引入共享
// reader；pi 的 runtime 链路回归由现有测试守护）。

import { reconstructFromFile } from "../../../session-reconstructor.ts";
import type {
  AgentUsageTotal,
  InternalToolCall,
  ToolCall,
  Turn,
} from "../../../types.ts";
import type { ReplayedTurn, SessionView } from "../../types.ts";

/** pi 引擎的 registry key（与 engines/pi/pi-engine.ts 的 PI_ENGINE_ID 同值锚定）。 */
export const PI_ENGINE_ID = "pi";

/** InternalToolCall → ToolCall（strip _status/startedTs 内部态，导出纯净形状）。 */
function toExportedToolCall(tc: InternalToolCall): ToolCall {
  return {
    toolName: tc.toolName,
    ...(tc.args !== undefined ? { args: tc.args } : {}),
    ...(tc.result !== undefined ? { result: tc.result } : {}),
    ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
  };
}

/** 各 turn usageDelta 聚合 → AgentUsageTotal（SessionView.usage 投影）。 */
function totalUsage(turns: Turn[]): AgentUsageTotal | undefined {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let has = false;
  for (const turn of turns) {
    if (turn.usageDelta === undefined) continue;
    has = true;
    input += turn.usageDelta.input;
    output += turn.usageDelta.output;
    cacheRead += turn.usageDelta.cacheRead;
    cacheWrite += turn.usageDelta.cacheWrite;
    cost += turn.usageDelta.cost ?? 0;
  }
  if (!has) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    total: input + output + cacheRead + cacheWrite,
  };
}

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
  const turns: ReplayedTurn[] = recon.turns.map((turn) => ({
    text: turn.text,
    thinking: turn.thinking,
    toolCalls: turn.toolCalls.map(toExportedToolCall),
    // 重建的是历史，reconstructor 已把全部 turn 闭合（closed 恒 true）
    closed: true,
  }));
  const usage = totalUsage(recon.turns);
  return {
    engineId: PI_ENGINE_ID,
    turns,
    ...(usage !== undefined ? { usage } : {}),
    source: "native",
  };
}
