// src/execution/engine/common/session-view-projection.ts
//
// Turn → ReplayedTurn 投影 + usage 聚合的单一实现（P5 收敛）。此前三份同构副本：
// common/journal-replay.ts（journal 重放投影）、engines/pi/pi-engine.ts read()（内联
// 重写）、engines/pi/reader.ts（native reader）——投影语义唯一（strip 内部态 + closed
// 恒 true + usageDelta 聚合），实现也必须唯一（防三处漂移）。
//
// 纯函数、零运行时依赖（仅类型 import）：reader.ts 的双端复用约束（设计 §3.3.7，
// xyz-agent runtime 可 import）对本模块同样成立。
//
// 设计权威源：docs/architecture/subagent-engine-abstraction.md §3.3.6（重放等价性）。

import type { AgentUsageTotal, InternalToolCall, ToolCall, Turn } from "../../types.ts";
import type { ReplayedTurn } from "../types.ts";

/** InternalToolCall → ToolCall（导出纯净形状，不泄漏 running/done/failed 内部状态机）。 */
function toExportedToolCall(tc: InternalToolCall): ToolCall {
  return {
    toolName: tc.toolName,
    ...(tc.args !== undefined ? { args: tc.args } : {}),
    ...(tc.result !== undefined ? { result: tc.result } : {}),
    ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
  };
}

/** Turn → ReplayedTurn：剥离内部态（closed 恒 true——重放物无进行时语义，§3.3.6）。 */
export function toReplayedTurn(turn: Turn): ReplayedTurn {
  return {
    text: turn.text,
    thinking: turn.thinking,
    toolCalls: turn.toolCalls.map(toExportedToolCall),
    closed: true,
  };
}

/** 各 turn usageDelta 聚合为 AgentUsageTotal（无任何 usage 数据时 undefined）。 */
export function aggregateUsage(turns: readonly Turn[]): AgentUsageTotal | undefined {
  let acc: AgentUsageTotal | undefined;
  for (const turn of turns) {
    const d = turn.usageDelta;
    if (!d) continue;
    if (!acc) acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0 };
    acc.input += d.input;
    acc.output += d.output;
    acc.cacheRead += d.cacheRead;
    acc.cacheWrite += d.cacheWrite;
    acc.cost += d.cost ?? 0;
  }
  if (acc) acc.total = acc.input + acc.output + acc.cacheRead + acc.cacheWrite;
  return acc;
}
