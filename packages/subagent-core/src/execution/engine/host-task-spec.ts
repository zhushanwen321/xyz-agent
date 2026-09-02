// src/execution/engine/host-task-spec.ts
//
// ExecuteOptions → AgentCallOpts 的宿主侧最小正向映射（U0：chat 工具域引擎分支）。
//
// [D6 任务形状合流] 产出类型从原 AgentTaskSpec 改为合流形状 AgentCallOpts（单一任务
// 形状，EnginePort.run 入参——原 AgentTaskSpec 已删除）。字段映射是 ExecuteOptions →
// AgentCallOpts 的中立直译（prompt=task 正文、description=slug 短标签；agent/model/
// thinkingLevel/skillPath/appendSystemPrompt/schema/maxTurns/graceTurns/worktree/cwd
// 同名透传）。不 import 任何具体引擎模块（registry.ts 依赖方向纪律：上层按中立类型
// 组装声明，引擎细节归引擎）。
//
// schemaEnv 不透传（与原 AgentTaskSpec 形态一致的字段面）：pi 边界直出时 schema 派生
// 优先——透传会在 chat 域引入「opts.schemaEnv 原值 vs compact 派生值」的取值源变化，
// 维持派生优先保证与合流前行为逐字节一致。
//
// conversation/fork 在调用本 mapper 前已被 capability-gate 预检拒绝（[D3-④]
// capabilities 驱动的调用前拒绝，非 pi 引擎 unsupported），透传仅保持映射完整性——
// 未来引擎支持时无需改本函数。

import type { AgentCallOpts } from "../../orchestration/models/types.ts";
import type { ExecuteOptions } from "../types.ts";

/** 纯函数：ExecuteOptions（chat 域执行选项）→ 合流任务声明 AgentCallOpts。无副作用、幂等。 */
export function executeOptionsToEngineTaskSpec(opts: ExecuteOptions): AgentCallOpts {
  return {
    prompt: opts.task,
    ...(opts.slug !== undefined ? { description: opts.slug } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
    ...(opts.skillPath !== undefined ? { skillPath: opts.skillPath } : {}),
    ...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.graceTurns !== undefined ? { graceTurns: opts.graceTurns } : {}),
    ...(opts.fork !== undefined ? { fork: opts.fork } : {}),
    ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.conversation !== undefined ? { conversation: opts.conversation } : {}),
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    // 运行期字段（signal/ctxModel）不入声明——归 RunContext（port.ts 删字段去向）。
  };
}
