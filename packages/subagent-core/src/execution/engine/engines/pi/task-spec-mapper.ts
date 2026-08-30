// src/execution/engine/engines/pi/task-spec-mapper.ts
//
// AgentTaskSpec ↔ ExecuteOptions 映射（P1 回填）。pi 专有语义的隔离点（设计 §3.3.5
// 删字段去向 + P1 行「ExecuteOptions→AgentTaskSpec 映射层」）：
//   - effort ↔ thinkingLevel：pi 的 7 档枚举是引擎私有语义，中立层只透传字符串——
//     pi 侧恒等映射（不识别的档位与现状一致：交 resolveModel 层处理）；
//   - persona ↔ skillPath + appendSystemPrompt：skillPath 并入 persona 语义（D2），
//     pi 侧原样还原（pi 的 persona 注入通道 = --skill/--append-system-prompt flag）；
//   - schemaEnv 内化：中立层无此字段，PiEngine 从 task.schema 派生（stringifySchemaCached
//     compact——与 agent-opts-resolver 同一函数同一缓存，逐字节等值，D-A6 bridge 保真）；
//   - conversation/idleTimeoutMs：interact 控制面的 task 标志，原名透传。
//
// 往返保真（验收 A1 的映射层证据）：executeOptionsToTaskSpec ∘ taskSpecToExecuteOptions
// 对全部 ExecuteOptions 字段恒等（schemaEnv 由 schema 派生后逐字节等于原值——resolver
// 与本 mapper 共用 WeakMap 缓存的同一 compact 串）。唯一归一化：appendSystemPrompt: []
// 归一为 persona 缺省（下游 spread 空数组与 undefined 均为 no-op，行为等价）。

import type { ModelInfo } from "../../../model-resolver.ts";
import type { ExecuteOptions } from "../../../types.ts";
import { stringifySchemaCached } from "../../../../shared/schema-jsonify.ts";
import type { AgentTaskSpec, PersonaSpec } from "../../types.ts";

/**
 * ExecuteOptions → AgentTaskSpec（宿主侧声明 → 引擎中立声明）。
 * 纯函数、无副作用——同一 opts 可重复转换（幂等）。
 */
export function executeOptionsToTaskSpec(opts: ExecuteOptions): AgentTaskSpec {
  // persona 归并：skillPath / appendSystemPrompt 有其一即建 persona，避免空对象噪声。
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
    // pi 7 档枚举 → 引擎无关 effort（恒等：档位集合是 pi 私有语义，中立层透传）
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
    // ExecuteOptions 不携带的运行期字段（signal/ctxModel/onComplete）归 RunContext；
    // schemaEnv 由 taskSpecToExecuteOptions 从 schema 派生。
  };
}

/**
 * AgentTaskSpec → ExecuteOptions（pi 引擎侧还原）。
 *
 * @param spec 中立任务声明
 * @param runCtx 运行期上下文：ctxModel 是 ExecuteOptions 的运行期字段（从 RunContext
 *               回填）；schemaEnvFallback 是解耦形态（有 schemaEnv 无 schema，生产
 *               不可达）的兜底透传——schema 可派生时派生优先（逐字节等值）
 */
export function taskSpecToExecuteOptions(
  spec: AgentTaskSpec,
  runCtx?: { ctxModel?: ModelInfo; schemaEnvFallback?: string },
): ExecuteOptions {
  return {
    task: spec.task,
    slug: spec.slug,
    // 身份解析键：spec.agent 优先；persona.agentRef 是 persona 注入通道的定位符，
    // 仅在 spec.agent 缺失时兜底（flag/file 通道引擎的主路径；pi 恒走 spec.agent）
    agent: spec.agent ?? spec.persona?.agentRef,
    model: spec.model,
    // effort → pi thinkingLevel（恒等映射）
    thinkingLevel: spec.effort,
    // persona 还原：pi 的注入通道是 --skill / --append-system-prompt flag
    skillPath: spec.persona?.skillPath,
    appendSystemPrompt: spec.persona?.appendSystemPrompt,
    schema: spec.schema,
    // schemaEnv 内化派生（D-A6 bridge）：与 agent-opts-resolver 共用 stringifySchemaCached
    // compact 缓存，输出逐字节等值。schema 缺失（无法派生）且调用方持有预编码值时兜底
    // 透传（解耦形态，生产不可达）；无 schema 亦无兜底时不设（BC-6：childEnv 不注入）。
    schemaEnv: spec.schema !== undefined
      ? stringifySchemaCached(spec.schema, "compact")
      : runCtx?.schemaEnvFallback,
    maxTurns: spec.maxTurns,
    graceTurns: spec.graceTurns,
    ctxModel: runCtx?.ctxModel,
    fork: spec.fork,
    worktree: spec.worktree,
    cwd: spec.cwd,
    conversation: spec.conversation,
    idleTimeoutMs: spec.idleTimeoutMs,
    // signal 不入 opts（PiEngine 直接传给 executeAndAwait 第 2 参，与 SAR 现行为一致）；
    // onComplete 不经引擎（workflow 路径从不设置；background 完成通知走 service 内部 notifier）。
    // denyTools/permissionMode：中立新字段，pi 链路暂无对应面（P2 公共层接 denylist 映射）。
  };
}
