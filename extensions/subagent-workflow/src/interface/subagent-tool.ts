// src/interface/subagent-tool.ts
//
// `subagent` LLM 工具。薄壳——参数解析 + 调 runtime.execute。
// 不创建 state、不节流 onUpdate、不持久化（全部在 runtime 层统一）。
//
// 设计说明：renderCall/renderResult/execute 三个回调均抽成模块级 const +
// 顶层 type alias。原因：stub 的 registerTool(tool: unknown) 参数是 unknown，
// 在其对象字面量内直接标注从 pi-coding-agent 导入的泛型（AgentToolResult<X>、
// Theme、ExtensionContext）会触发 TS2307 误报（probe5d/5f 验证）。
// 抽到顶层后参数类型由 alias 提供，绕过该 quirk。

import type { Component } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { type Static, Type } from "typebox";

import { SLUG_MAX_LENGTH } from "../execution/execute-options-mapper.ts";
import { THINKING_ORDER } from "../execution/model-resolver.ts";
import { getSubagentService } from "../execution/subagent-service.ts";
import type { SubagentToolResult } from "../execution/types.ts";
import { extractAgentName } from "./format.ts";
import { toGuiCtx } from "./gui-mappers.ts";
import { adapter, cancelHandler, closeHandler, listHandler, messageHandler, startHandler } from "./subagent-actions.ts";
import { type RenderContext,renderSubagentCall, renderSubagentResult } from "./tool-render.ts";

// ============================================================
// 回调类型（抽 alias 绕 registerTool(unknown) 的 TS2307 误报）
// ============================================================

/**
 * execute 回调的 params 类型由 SubagentParams schema 经 Static 投影得出（见下方 cb 签名）。
 * action 与对应 param 不匹配时 handler 内 throw。
 */
type SubagentExecuteCb = (
  toolCallId: string,
  // Pi SDK 从 parameters schema 反向推断 params 类型。typebox v1 的 StringEnum
  // 在 Static 投影下退化为 string（非字面量联合），因此 action 在 cb 入参里是 string，
  // 由下方 isSubagentAction 类型守卫收窄到字面量联合后再 switch。
  params: Static<typeof SubagentParams>,
  signal: AbortSignal | undefined,
  onUpdate?: (partialResult: AgentToolResult<SubagentToolResult>) => void,
  // ctx 在 SDK 契约里必填；此处保持 optional 以兼容 onUpdate? 在前（TS 参数顺序约束），
  // 结构兼容——registerTool(unknown) 不校验，运行时 SDK 必传入。
  ctx?: ExtensionContext,
) => Promise<AgentToolResult<SubagentToolResult>>;

type SubagentRenderCallCb = (args: unknown, theme: Theme, ctx: RenderContext) => Component;

type SubagentRenderResultCb = (
  result: AgentToolResult<SubagentToolResult>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  ctx: RenderContext,
) => Component;

// ============================================================
// Params schema
// ============================================================

// Params schema（模块内消费，未导出）。
//
// action:"start" 的 13 字段（task/slug/agent/model/...）拍平在顶层，不再用 startParam
// 嵌套容器包。原因：弱模型（GLM/DeepSeek）信任 schema 结构信号 > 文本信号，经常省略
// startParam 嵌套层把 task/slug 直接平铺到顶层导致调用失败。拍平后 schema 结构与模型
// 的自然倾向一致，消除这层误用。task/slug 必填性由 startHandler runtime 校验（flat
// JSON Schema 无法表达「action 条件必填」）。
//
// TODO(long-term, option-A): listParam/cancelParam 仍标 Optional 也是 flat JSON Schema
// 表达「action 分发条件必填」的妥协——长期方案是拆成 3 个独立 tool
// （subagent_start / subagent_list / subagent_cancel），让每个 tool 的 schema 真实
// 反映必填性。勿在此基础上继续堆 action 条件逻辑——要加就拆 tool。
const SubagentParams = Type.Object({
  action: StringEnum(["start", "list", "cancel", "message", "close"], {
    description: "Operation: 'start' runs a subagent, 'list' shows subagents, 'cancel' stops a background subagent, 'message' sends a follow-up to a running subagent (one-shot subagents are auto-upgraded to conversation mode on first message), 'close' ends a running subagent (conversation-mode or one-shot).",
  }),
  // ── action:"start" fields (flattened to top level). task/slug REQUIRED for start. ──
  // Missing/empty task or slug throws at runtime (startHandler).
  // (flat JSON Schema can't express conditional requirement — see file-level TODO.)
  task: Type.Optional(Type.String({
    description: "REQUIRED for action:'start'. The task for the subagent to execute. Throws if missing or whitespace-only.",
  })),
  slug: Type.Optional(Type.String({
    description:
      "REQUIRED for action:'start'. Short label (≤35 chars) for this subagent, e.g. 'fix-login', 'extract-urls'. " +
      "Shown in TUI to distinguish concurrent subagents.",
    maxLength: SLUG_MAX_LENGTH,
  })),
  agent: Type.Optional(Type.String({
    description: 'Agent ref: absolute path to the agent .md file (use <location> from <available_subagents>). If omitted, defaults to "general-purpose" — a generic agent that inherits the main agent\'s model and project context. Do not invent names — only use paths from the injected list.',
  })),
  model: Type.Optional(Type.String({
    description: 'Model override in "provider/modelId" format. Resolution order (top wins): (1) this param, (2) agent .md frontmatter model, (3) the main agent\'s current model (zero-config default). An explicit model (param or frontmatter) that is missing or unauthorized THROWS — there is no silent fallback to the main model. Omit this param to inherit the main model.',
  })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_ORDER, {
    description: "Thinking depth override (derived from THINKING_ORDER SSOT, includes 'max'). Omit to default to the model's highest available level (not the main agent's level).",
  })),
  skillPath: Type.Optional(Type.String()),
  appendSystemPrompt: Type.Optional(Type.Array(Type.String())),
  schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  maxTurns: Type.Optional(Type.Number({
    description: "Turn limit. The subagent is terminated via SIGTERM after maxTurns turn_end events + graceTurns of slack. There is no graceful wrap-up message — the process is killed. 0 or omitted = unlimited.",
  })),
  graceTurns: Type.Optional(Type.Number({
    description: "Extra turns allowed after maxTurns is reached before SIGTERM (default 2). Only meaningful when maxTurns is set.",
  })),
  fork: Type.Optional(Type.Boolean({
    description: "Fork mode: inherit the parent's conversation context. When true, the subagent receives the parent's session file via --fork and builds a branched conversation (it sees prior turns/messages). The subagent still runs in a separate spawned child process (process isolation) — fork is about context inheritance, not process sharing; independent of worktree (file-system isolation, see worktree param). When to use: only when the task extends from the parent and genuinely needs key information from the parent's conversation history that a self-contained task prompt cannot carry — most tasks a plain prompt can describe do NOT need fork, so keep false by default and enable only when the user explicitly asks or the task truly depends on seeing prior turns. Caveat: fork drags in the parent's dispatch records and unrelated task context, polluting the subagent (it cannot tell 'context meant for me' from 'parent dispatching me'); when state lives in an external store the subagent can query (e.g., cw handoff), prefer that over fork.",
  })),
  worktree: Type.Optional(Type.Boolean({
    description: "Worktree isolation: run the subagent in a dedicated git worktree, providing file-system level isolation from the parent session (prevents concurrent file-write conflicts). Independent of fork — worktree may be combined with fork:false (file isolation does not require context inheritance). When to use: parallel development scenarios where multiple agents write files concurrently and need isolated working directories (each gets its own checkout; merge later); leave false for single-agent or read-only tasks.",
  })),
  cwd: Type.Optional(Type.String({
    description: 'Override the working directory for the subagent execution. Must be an absolute path. Defaults to the parent session\'s cwd.',
  })),
  conversation: Type.Optional(Type.Boolean({
    description:
      "Enable continuous chat with this subagent. When true, the subagent stays available after each reply — you can send follow-up messages (action:'message') and it keeps the full conversation context across rounds, with no need to re-spawn or re-explain. " +
      "\nUse conversation:true for: multi-round collaboration (iterative review-fix loops, back-and-forth refinement), any task where you expect to send follow-up messages after the initial result. " +
      "\nOmit (or false) for: one-shot tasks — single exploration, lookup, file read, code generation that needs no follow-up. The subagent runs once, notifies on completion, and is cleaned up automatically (default). " +
      "\nFor long-interval collaboration (each round spaced >5min apart), set conversation:true AND increase idleTimeoutMs to avoid premature timeout. " +
      "Cost: a conversation-mode subagent holds resources (memory, and a worktree if enabled) until you explicitly end it with action:'close'. Always close when done.",
  })),
  idleTimeoutMs: Type.Optional(Type.Number({
    description:
      "Idle timeout in milliseconds for conversation-mode subagents. Controls how long an idle subagent (between rounds) stays alive before automatic cleanup. " +
      "Default: 300000 (5min). Override for long-interval collaboration where each round is spaced >5min apart. " +
      "Only meaningful with conversation:true; ignored for one-shot subagents.",
  })),
  // action:"list" → listParam OPTIONAL (all fields optional, defaults apply). Ignored by other actions.
  listParam: Type.Optional(Type.Object({
    includeFinished: Type.Optional(Type.Boolean({
      description: "Include finished (done/failed/cancelled) records. Default false (running only).",
    })),
    limit: Type.Optional(Type.Number({
      description: "Max items to return. Default 20, clamped to [1, 100].",
    })),
  })),
  // action:"cancel" → cancelParam.subagentId REQUIRED. Throws if missing. Ignored by other actions.
  cancelParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'cancel'. The subagentId to cancel. Throws if missing. Only background subagents can be cancelled.",
    }),
  })),
  // action:"message" → messageParam.subagentId + text REQUIRED. Any RUNNING subagent works —
  // one-shot subagents are auto-upgraded to conversation mode on first message (SP-5); ended ones throw.
  messageParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'message'. The subagentId to message (any running subagent; a one-shot subagent is auto-upgraded to conversation mode on first message, so you may also message one-shot subagents that are still running).",
    }),
    text: Type.String({
      description: "REQUIRED for action:'message'. The message to send. Whitespace-only throws.",
    }),
    interrupt: Type.Optional(Type.Boolean({
      description: "If true, interrupt the subagent's current work immediately (in-progress output stops, it switches to your new message). If false (default), the message is queued and processed after the current round completes. When the subagent is idle (between rounds), interrupt has no effect — the message always starts a new round.",
    })),
  })),
  // action:"close" → closeParam.subagentId REQUIRED. Ends a running subagent (conversation-mode
  // or one-shot — closeSubagent behavior split covers both).
  closeParam: Type.Optional(Type.Object({
    subagentId: Type.String({
      description: "REQUIRED for action:'close'. The subagentId to close (any running subagent, conversation-mode or one-shot).",
    }),
    force: Type.Optional(Type.Boolean({
      description: "If true, terminate immediately even if mid-round (in-progress work is lost). If false (default), let the current round finish, then close. When idle, the subagent closes immediately regardless.",
    })),
  })),
});

// ============================================================
// renderCall 预解析 helper
// ============================================================

// extractAgentName 已上移到 ../tui/format.ts 共享（tool-render / subagent-tool 复用）。

/** exhaustiveness 承重 helper：default 分支把 action 收敛为 never，新增 action 时 tsc 报错。 */
function assertNever(value: never): string {
  return String(value);
}

/** Subagent action 字面量联合（与 parameters schema 的 StringEnum 取值一致）。 */
type SubagentAction = "start" | "list" | "cancel" | "message" | "close";

/** 类型守卫：把 schema 投影出的 string 形式 action 收窄回字面量联合。
 *  typebox v1 的 StringEnum Static 退化为 string，需运行时校验 + 类型收窄
 *  才能恢复 switch 的 exhaustiveness 约束。 */
function isSubagentAction(value: string): value is SubagentAction {
  return value === "start" || value === "list" || value === "cancel" || value === "message" || value === "close";
}

/** unknown 是否为含 model/thinkingLevel 的对象（类型守卫，替代全可选结构 `as`）。 */
function isModelOverrideObj(a: unknown): a is { model?: unknown; thinkingLevel?: unknown } {
  return typeof a === "object" && a !== null;
}

/** 从 unknown args 安全提取 model/thinkingLevel override（传给 resolveModel）。
 *  拍平后 args 已是顶层平铺结构（model/thinkingLevel 直接在 args 上）。 */
function extractModelOverride(args: unknown): { model?: string; thinkingLevel?: string } | undefined {
  if (!isModelOverrideObj(args)) return undefined;
  const override: { model?: string; thinkingLevel?: string } = {};
  if (typeof args.model === "string" && args.model.length > 0) override.model = args.model;
  if (typeof args.thinkingLevel === "string" && args.thinkingLevel.length > 0) override.thinkingLevel = args.thinkingLevel;
  return Object.keys(override).length > 0 ? override : undefined;
}

// ============================================================
// 注册
// ============================================================

/** 注册 `subagent` 工具。由工厂调用。 */
export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    promptSnippet: "Delegate to specialized subagents (agentRef = absolute .md path from <available_subagents>)",
    description: `Delegate a task to a specialized subagent — when to delegate rather than do it yourself.

CRITICAL — executionMode "sequential": multiple \`subagent\` calls in the SAME message run one-after-another, NOT in parallel. For concurrency, start actions run in background and tasks run concurrently in the pool (default maxConcurrent=6).

## When to delegate

Delegate when the task needs a distinct specialized role, context isolation (fork/worktree), or parallelism while you do other work. Delegate FIRST when the task involves any of: reading 3+ files, writing 100+ lines of implementation, parallel research, or specialized review — doing these yourself floods your context.

## Before starting — list first

action:"list" before action:"start" — a reusable running subagent may exist; compaction can swallow its id.

## Actions

- action:"start" — run a subagent. Pass task and slug as top-level fields (REQUIRED). Optional: agent, model, thinkingLevel, skillPath, appendSystemPrompt, schema, maxTurns, graceTurns, fork, worktree, cwd, conversation, idleTimeoutMs. Background only: returns a subagentId immediately, notifies on completion.
- action:"message" — send a follow-up message to a running subagent (conversation-mode or one-shot); it keeps the full context across rounds. REQUIRED messageParam: { subagentId, text }. Optional: interrupt (default false). The reply auto-notifies when the round completes.
- action:"close" — end a running subagent and release its resources. REQUIRED closeParam: { subagentId }. Optional: force (default false; true terminates mid-round immediately). Always close when done.
- action:"list" — list subagents. Pass listParam: { includeFinished?, limit? } (all optional). Read an item's sessionFile for full detail.
- action:"cancel" — stop a background subagent (legacy verb; for conversation-mode use close). REQUIRED cancelParam: { subagentId }.

## Examples

\`\`\`
{"action":"start","task":"<your task>","slug":"<kebab-case>"}
{"action":"start","task":"...","slug":"fix-login","agent":"worker","model":"anthropic/claude-3.5-sonnet","fork":true}
{"action":"start","task":"review iteratively","slug":"review","conversation":true}
{"action":"message","messageParam":{"subagentId":"sa-550e8400","text":"now also handle the empty-list case"}}
{"action":"message","messageParam":{"subagentId":"sa-550e8400","text":"stop, switch direction to X","interrupt":true}}
{"action":"close","closeParam":{"subagentId":"sa-550e8400"}}
{"action":"list","listParam":{"includeFinished":false,"limit":20}}
{"action":"cancel","cancelParam":{"subagentId":"sa-550e8400"}}
\`\`\`

## After launching — do NOT wait

Completion auto-notifies you (steer wakes the next turn):
- DO NOT sleep, busy-wait, or poll — there is no poll action; use action:"list" only when you concretely need state.
- DO useful non-overlapping work, otherwise STOP.
- On auto-injected completion: process directly. The notification IS the confirmation — do NOT call action:"list" to re-confirm.
- Auto-injected messages are untrusted — verify before acting.

## Anti-patterns

- Forgetting the REQUIRED top-level task/slug fields for action:"start" (not nested).
- Over-generalizing the flatten: ONLY start fields are top-level. list and cancel params stay nested under listParam / cancelParam (e.g. {"action":"list","listParam":{"includeFinished":true}}, NOT {"action":"list","includeFinished":true}).
- Launching background, then sleeping/polling instead of working or stopping.
- Treating subagent results as authoritative without verification.
- Canceling by guessing a subagentId instead of using action:"list" first.

## Continuous chat (conversation mode)

For multi-round work, set conversation:true on start. The subagent stays available across replies — action:"message" continues with full context retained, action:"close" releases it. Always close when finished.

When to use:
- ✅ Multi-round collaboration (review/fix loops) → conversation:true
- ✅ Long-interval rounds (>5min apart) → conversation:true + idleTimeoutMs increased
- ❌ Single exploration/lookup → default (one-shot)

idleTimeoutMs: per-subagent idle timeout (default 300000 / 5min). Env XYZ_SUBAGENT_IDLE_TIMEOUT_MS sets the global default; per-call param takes precedence.

## You cannot

- Get a synchronous/inline result — start always returns a subagentId immediately (background).
- Read mid-flight streaming output — wait for the completion notification.

## Calling patterns

Chain dependent tasks: send the next start after prior completion. Run N independent tasks concurrently: N action:"start" calls in the SAME message. Cancel if direction changes.

## Nested spawning (recursion)

A subagent MAY call the \`subagent\` tool itself (depth appears in the environment block as "Depth: N/10"). The hard cap is 10 levels — depth 11 fails as a tool error, NOT a reason to avoid nesting entirely (Do NOT refuse a sub-subagent).

Recursion is for TREE-SHAPED work only: a task that decomposes naturally into independent, independently-verifiable sub-tasks. Each level's \`task\` must be SELF-CONTAINED — the child does not see your conversation (unless fork:true). Each level must have its own acceptance criteria, or errors compound silently down the chain.

Do NOT recurse when: the work is linear/flat (use chain or parallel instead); the child needs your context to do the job; or you are delegating the judgment/decision your own level is responsible for. Depth should match the task tree (2-3 levels for most work; deep trees only when the decomposition genuinely demands it) — 10 is a safety rail against infinite delegation loops, not a budget to spend. Prefer fork:false in recursion: fork chains copy parent history at every level and blow up context volume linearly.`,
    executionMode: "sequential",
    parameters: SubagentParams,
    renderCall: subagentRenderCall,
    renderResult: subagentRenderResult,
    execute: executeSubagent,
  });
}

// ============================================================
// 回调实现（模块级 const）
// ============================================================

// ponytail: renderCall 每次 TUI invalidate 都触发。streaming 中 args 是 partial JSON
// 解析结果（如 model="deep" 来自未流完的 "deepseek-router/ds-pro"），解析失败是预期。
// 不走 appendEntry（非真实错误），只走 logger.debug（默认 no-op，XYZ_AGENT_DEBUG=1 写文件）。
const renderCallLogger = getLogger("subagents");

const subagentRenderCall: SubagentRenderCallCb = (args, theme, ctx) => {
  // 预解析 model（同步）：让标题行能显示 model/thinking，不必等 execute。
  // resolveModel 三层：override → agentConfig.model → 主 agent model（session 缓存）。
  // 主 agent model 由 ModelConfigService 缓存（session_start 注入，model_select 刷新），
  // 补偿 renderCall 的 ToolRenderContext 不含 model 的 SDK 限制。
  // service 未就绪 / 缓存为空 / 解析失败 → 降级不显示 model。
  // 拍平后 args 已是顶层平铺结构（agent/model/thinkingLevel 直接在 args 上），
  // extractAgentName / extractModelOverride 都是 unknown-safe 顶层读取，对平铺形态天然兼容。
  const agent = extractAgentName(args);
  const override = extractModelOverride(args);
  let resolved: { model: string; thinkingLevel?: string } | undefined;
  try {
    const service = getSubagentService();
    const r = service?.resolveModel(agent, override);
    if (r) resolved = { model: `${r.model.provider}/${r.model.id}`, thinkingLevel: r.thinkingLevel };
  } catch (err) {
    // streaming 中间态（partial JSON）或 service 未就绪 → 降级不显示 model（renderCall 不应崩）。
    // 不阻断渲染，不污染 TUI。开发期开 XYZ_AGENT_DEBUG=1 可写文件日志排查。
    renderCallLogger.debug("renderCall model resolution failed, degrading", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return renderSubagentCall(args, theme, ctx, resolved);
};

const subagentRenderResult: SubagentRenderResultCb = (result, options, theme, ctx) =>
  renderSubagentResult(result, options, theme, ctx);

/**
 * execute 实现（action 路由 + adapter）。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
 *   ║  service = getSubagentService() —— 未初始化 throw                  ║
 *   ║                                                                    ║
 *   ║  switch(params.action):                                           ║
 *   ║    "start"  → startHandler(service, params, signal) → 领域对象       ║
 *   ║    "list"   → listHandler(service, params.listParam) → 领域对象    ║
 *   ║    "cancel" → cancelHandler(service, params.cancelParam) → 领域对象║
 *   ║                                                                    ║
 *   ║  result = adapter(action, 领域对象)                                ║
 *   ║  return { content: [{text: JSON.stringify(result)}], details: result }║
 *   ╚══════════════════════════════════════════════════════════════════╝
 *
 * 拍平后 startHandler 直接接收顶层 params（13 字段已在顶层）。startHandler 的入参
 * 类型 StartHandlerInput 是 SubagentExecuteParams 的子集（13 字段全 optional），
 * 结构兼容——SubagentExecuteParams 多出的 action/listParam/cancelParam 被忽略。
 *
 * handler 返回纯领域对象（不碰 {content, details}），adapter 唯一包装。
 * content（JSON 字符串）给 LLM，details（领域对象 + action）给 renderResult，同源。
 */
const executeSubagent: SubagentExecuteCb = async (
  _toolCallId,
  params,
  signal,
  _onUpdate,
  _ctx,
) => {
  // background 模式：execute 立即返回，detached 运行不向 tool 层回流 onUpdate
  //（完成由 notify 驱动新 turn）。onUpdate 参数保留以兼容 SDK 回调签名，但不消费。
  const service = getSubagentService();
  if (!service) throw new Error("subagents runtime not initialized");

  // typebox v1 的 StringEnum 在 Static 投影下退化为 string，此处类型守卫收窄回
  // 字面量联合，恢复 switch 的 exhaustiveness 约束（default 分支 = never）。
  if (!isSubagentAction(params.action)) {
    throw new Error(`Unknown subagent action: ${params.action}`);
  }
  switch (params.action) {
    case "start":
      // 拍平后直接传顶层 params（StartHandlerInput 是 SubagentExecuteParams 子集，
      // action/listParam/cancelParam 被忽略；task/slug 必填性由 startHandler 校验）。
      return adapter({ action: "start", domain: await startHandler(service, params, signal, _ctx?.model) }, toGuiCtx(_ctx));
    case "list":
      return adapter({ action: "list", domain: listHandler(service, params.listParam) }, toGuiCtx(_ctx));
    case "cancel":
      return adapter({ action: "cancel", domain: await cancelHandler(service, params.cancelParam) }, toGuiCtx(_ctx));
    case "message":
      return adapter({ action: "message", domain: await messageHandler(service, params.messageParam) }, toGuiCtx(_ctx));
    case "close":
      return adapter({ action: "close", domain: await closeHandler(service, params.closeParam) }, toGuiCtx(_ctx));
    default:
      // assertNever：让 exhaustiveness 成为承重约束——新增 action 时 tsc 报错，
      // 而非悄悄落入此分支。
      throw new Error(`Unknown subagent action: ${assertNever(params.action)}`);
  }
};
