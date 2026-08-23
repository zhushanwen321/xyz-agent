/**
 * command-actions — RPC 模式 slash command action 解析纯函数。
 *
 * xyz-agent GUI 通过 `client.prompt("/subagents cancel <id>")` 等触发生命周期操作，
 * 不经 LLM（pi 的 _tryExecuteExtensionCommand 在 agent loop 前短路）。command handler
 * 在 RPC 模式下用这两个函数解析 action 字符串，分发到对应 service/lifecycle 调用。
 *
 * 设计为纯函数（无 ctx / service 依赖），便于独立单测，handler 只做薄分发。
 */

/** /subagents RPC action 判别联合。 */
export type SubagentRpcAction =
  | { action: "cancel"; recordId: string }
  | { action: "cancel-missing-id" }
  | { action: "noop" };

/** /workflows RPC action 判别联合。 */
export type WorkflowRpcAction =
  | { action: "abort"; runId: string }
  | { action: "lifecycle-missing-id"; verb: LifecycleVerb }
  | { action: "lifecycle-removed"; verb: "pause" | "resume" }
  | { action: "noop" };

/** workflow lifecycle verb 类型。 */
type LifecycleVerb = "abort";

/** workflow lifecycle verb 集合。 */
const LIFECYCLE_VERBS: ReadonlySet<LifecycleVerb> = new Set(["abort"]);

/** verb 是否为 lifecycle action（类型守卫，收窄到 LifecycleVerb）。 */
function isLifecycleVerb(verb: string): verb is LifecycleVerb {
  return LIFECYCLE_VERBS.has(verb as LifecycleVerb);
}

/**
 * 已移除的 lifecycle verb 集合（pause/resume——run 一次性生命周期化后删除，
 * 解析为 lifecycle-removed 提示，而非 unknown noop）。
 */
const REMOVED_LIFECYCLE_VERBS: ReadonlySet<"pause" | "resume"> = new Set([
  "pause",
  "resume",
]);

/** verb 是否为已移除的 lifecycle action（类型守卫，收窄到 "pause" | "resume"）。 */
function isRemovedLifecycleVerb(verb: string): verb is "pause" | "resume" {
  return REMOVED_LIFECYCLE_VERBS.has(verb as "pause" | "resume");
}

/**
 * 解析 /subagents RPC 命令字符串。
 *
 * 支持格式：
 * - `cancel <id>` → { action: "cancel", recordId }
 * - `cancel`（无 id）→ { action: "cancel-missing-id" }
 * - 其他（空 / 未知 action / 无参）→ { action: "noop" }
 *
 * noop 表示 GUI 端无对应程序化操作（GUI 已在 CommandPopover 屏蔽 /subagents 入口，
 * 此分支仅兜底手动 prompt）。
 */
export function parseSubagentRpcCommand(argsStr: string): SubagentRpcAction {
  const args = argsStr.trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) return { action: "noop" };

  const [verb, recordId] = args;
  if (verb === "cancel") {
    if (!recordId) return { action: "cancel-missing-id" };
    return { action: "cancel", recordId };
  }
  return { action: "noop" };
}

/**
 * 解析 /workflows RPC 命令字符串。
 *
 * 支持格式：
 * - `abort <runId>` → { action: "abort", runId }
 * - `abort`（无 runId）→ { action: "lifecycle-missing-id", verb: "abort" }
 * - `pause|resume ...`（已移除的 lifecycle verb，带或不带 runId 均同）→
 *   { action: "lifecycle-removed", verb }——removed verb 优先于 missing-id 判定
 *  （提示语义优先：用户应得知能力已删除并获 abort 指引，而非被引导补 runId）
 * - 其他（空 / 未知 action / 无参）→ { action: "noop" }
 */
export function parseWorkflowRpcCommand(argsStr: string): WorkflowRpcAction {
  const args = argsStr.trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) return { action: "noop" };

  const [verb, runId] = args;
  if (isRemovedLifecycleVerb(verb)) {
    return { action: "lifecycle-removed", verb };
  }
  if (isLifecycleVerb(verb)) {
    if (!runId) return { action: "lifecycle-missing-id", verb };
    return { action: verb, runId };
  }
  return { action: "noop" };
}
