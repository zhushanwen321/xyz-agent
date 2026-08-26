// execution/engine/legacy-bridge.ts
//
// ExecuteOptions → AgentTaskSpec 映射层（D2：中立类型从现有类型泛化，不另起炉灶）。
// A1 快照锚点的落点：映射保证 pi 路径行为零变化——
//   - schemaEnv 内化：PiEngine launcher 从 task.schema 派生 env 值，与现有
//     applySchemaEnvToChildEnv 逐字节等值（BC-3，session-runner-schema-env.test 守护）
//   - signal/ctxModel 从 ExecuteOptions 剥离到 RunContext；onComplete 不进引擎层
//   - thinkingLevel → effort（pi 7 档语义剥离）；skillPath → persona.skillPath 收拢
//
// 改造点承接：session-runner / subagent-service 收口改造后经本模块进引擎层
// （宿主编排壳保留：record/worktree/生命周期编排不动，spawn 细节下沉 engines/）。

import type { ExecuteOptions } from "@real/execution/types.ts";
import type { AgentTaskSpec, PersonaSpec, RunContext } from "./types.ts";

/**
 * ExecuteOptions → AgentTaskSpec（字段级透传映射——A1 行为零变化的机械保证）。
 * 泛化 5 处逐一锚定（§3.3.5）：effort(persona/…)/persona/schemaEnv 内化/denyTools+permissionMode 通道。
 */
export function toAgentTaskSpec(opts: ExecuteOptions): AgentTaskSpec {
  const persona: PersonaSpec | undefined = opts.skillPath || opts.appendSystemPrompt
    ? {
        skillPath: opts.skillPath,
        appendSystemPrompt: opts.appendSystemPrompt,
      }
    : undefined;
  return {
    task: opts.task,
    slug: opts.slug,
    agent: opts.agent,
    model: opts.model,
    // 泛化 ①：thinkingLevel（pi 7 档）→ 中立 effort（引擎各自映射或忽略）
    effort: opts.thinkingLevel,
    // 泛化 ②：skillPath + appendSystemPrompt 收拢为 persona
    persona,
    schema: opts.schema,
    maxTurns: opts.maxTurns,
    graceTurns: opts.graceTurns,
    fork: opts.fork,
    worktree: opts.worktree,
    cwd: opts.cwd,
    conversation: opts.conversation,
    idleTimeoutMs: opts.idleTimeoutMs,
    // 泛化 ③：schemaEnv 不映射——launcher 从 task.schema 派生（BC-3 byte 级等值锚点）
    // 泛化 ④⑤：denyTools / permissionMode 为新增中立通道，ExecuteOptions 现无对应字段（undefined）
  };
}

/**
 * ExecuteOptions 的运行期句柄 → RunContext（signal/ctxModel 剥离自任务声明，D2）。
 * onEvent 由宿主编排层接（journal writer 的 append——host 落盘链路）。
 */
export function toRunContext(
  opts: ExecuteOptions,
  taskId: string,
  poolKey: string,
  onEvent?: (event: import("./types.ts").AgentEvent) => void,
): RunContext {
  return {
    taskId,
    poolKey,
    signal: opts.signal,
    onEvent,
    ctxModel: opts.ctxModel, // ExecuteOptions.ctxModel 已是 ModelInfo（同源 model-resolver）——直接透传
  };
}
