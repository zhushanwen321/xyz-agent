// src/execution/engine/host-task-spec.ts
//
// ExecuteOptions → AgentTaskSpec 的宿主侧最小正向映射（U0：chat 工具域引擎分支）。
//
// 与 engines/pi/task-spec-mapper.ts 的关系：那是 pi 引擎方向的映射（taskSpecToExecuteOptions
// 还原 + schemaEnv 内化派生等 pi 专有语义），归属 pi 引擎模块；本 mapper 服务宿主编排层
// （subagent-service 引擎分支），不 import 任何具体引擎模块（registry.ts 依赖方向纪律：
// 上层按中立类型组装声明，引擎细节归引擎）。字段映射是 ExecuteOptions → AgentTaskSpec
// 的中立直译（task/slug/agent/model 原样；thinkingLevel → effort；skillPath +
// appendSystemPrompt → persona；schema/maxTurns/graceTurns/worktree/cwd 原样透传）。
//
// conversation/fork 在调用本 mapper 前已被 capability-gate 预检拒绝（[D3-④]
// capabilities 驱动的调用前拒绝，非 pi 引擎 unsupported），透传仅保持映射完整性——
// 未来引擎支持时无需改本函数。

import type { ExecuteOptions } from "../types.ts";
import type { AgentTaskSpec, PersonaSpec } from "./types.ts";

/** 纯函数：ExecuteOptions（chat 域执行选项）→ 引擎中立任务声明。无副作用、幂等。 */
export function executeOptionsToEngineTaskSpec(opts: ExecuteOptions): AgentTaskSpec {
  // persona 归并口径与 pi mapper 一致：skillPath / appendSystemPrompt 有其一即建，
  // 避免空对象噪声（下游 spread 空数组与 undefined 均为 no-op）。
  const persona: PersonaSpec | undefined =
    opts.skillPath !== undefined || opts.appendSystemPrompt !== undefined
      ? {
        ...(opts.skillPath !== undefined ? { skillPath: opts.skillPath } : {}),
        ...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
      }
      : undefined;
  return {
    task: opts.task,
    slug: opts.slug,
    agent: opts.agent,
    model: opts.model,
    // pi 7 档 thinkingLevel 是引擎私有语义——中立层透传 effort 字符串，各引擎自行映射
    effort: opts.thinkingLevel,
    ...(persona !== undefined ? { persona } : {}),
    schema: opts.schema,
    maxTurns: opts.maxTurns,
    graceTurns: opts.graceTurns,
    fork: opts.fork,
    worktree: opts.worktree,
    cwd: opts.cwd,
    conversation: opts.conversation,
    idleTimeoutMs: opts.idleTimeoutMs,
    // 运行期字段（signal/ctxModel）不入声明——归 RunContext（port.ts 删字段去向）。
  };
}
