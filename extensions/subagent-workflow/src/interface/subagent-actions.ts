// src/interface/subagent-actions.ts
//
// subagent tool 的内部 handler + 唯一 adapter。
//
// 分层（spec FR-2）：
//   1. startHandler / listHandler / cancelHandler —— 纯领域对象进出，不碰 {content, details}
//   2. adapter(action, 领域对象) —— 唯一包装为 AgentToolResult<SubagentToolResult>
//
// content（JSON 字符串）给 LLM，details（SubagentToolResult）给 renderResult，同源同处生成。

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  guiComponent,
  type GuiContext,
  guiResult,
  isGuiCapable,
} from "@xyz-agent/extension-protocol";

import { SLUG_MAX_LENGTH } from "../execution/execute-options-mapper.ts";
import { computeElapsedSeconds } from "../execution/execution-record.ts";
import { isResumable } from "../execution/lifecycle-predicates.ts";
import type { ExecutionRecord } from "../execution/types.ts";
import type { ModelInfo } from "../execution/model-resolver.ts";
import type { SubagentService } from "../execution/subagent-service.ts";
import { displayAgentName } from "../shared/agent-ref.ts";
import type {
  BgResponse,
  CancelResponse,
  CloseResponse,
  ExecutionStatus,
  ExternalState,
  ListResponse,
  MessageResponse,
  SubagentListItem,
  SubagentRecord,
  SubagentToolResult,
} from "../execution/types.ts";
import { mapRunIcon, mapRunStatus } from "./gui-mappers.ts";

// ============================================================
// 常量
// ============================================================

/** list 默认 limit。 */
const DEFAULT_LIST_LIMIT = 20;
/** list limit 上限。 */
const MAX_LIST_LIMIT = 100;

/** background 启动提示文案（spec FR-3 bgResponse.message）。 */
const BG_MESSAGE = "detached, will notify on completion (auto-injected message, do not poll)";

/** subagentId（UUID）在 GUI header 的截断显示长度。 */
const SUBAGENT_ID_PREVIEW = 8;

// ============================================================
// 入参 / 出参类型
// ============================================================

/** start 入参（拍平后从 tool params 顶层来，task + slug 必填）。
 *  StartHandlerInput 是 SubagentExecuteParams 的子集（13 字段全 optional）；
 *  调用方传整个 params（含 action/listParam/cancelParam），多余字段被忽略。 */
export interface StartHandlerInput {
  task?: string;
  /** 短标签（≤35 字符，kebab-case），必填。 */
  slug?: string;
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  /** fork 模式：继承主 session 上下文（D-018 两级降级）。 */
  fork?: boolean;
  /** worktree 模式：文件系统隔离运行（D-008 tmpdir）。 */
  worktree?: boolean;
  /** 覆盖子 agent 工作目录（默认 mainCwd）。 */
  cwd?: string;
  /** 可持续对话模式（true = chatMode，轮次完成进 idle 等续聊）。 */
  conversation?: boolean;
  /** 空闲超时毫秒数（仅 conversation 模式有意义，覆盖默认 5min）。 */
  idleTimeoutMs?: number;
}

/** start 领域对象（adapter 包成 bgResponse）。 */
export type StartHandlerResult = {
  kind: "bg";
  subagentId: string;
  sessionFile: string | undefined;
  /** 短标签，来自 record（handle.details.slug）。用于 result 行展示。 */
  slug: string;
  response: BgResponse;
};

export interface ListHandlerInput {
  includeFinished?: boolean;
  limit?: number;
}

/** list 领域对象（adapter 包成 listResponse，最外层 subagentId/sessionFile 为 null）。 */
export interface ListHandlerResult {
  response: ListResponse;
}

export interface CancelHandlerInput {
  subagentId?: string;
}

/** cancel 领域对象（adapter 包成 cancelResponse）。 */
export interface CancelHandlerResult {
  subagentId: string;
  response: CancelResponse;
}

// ============================================================
// helpers（模块内）
// ============================================================

/**
 * list 数据源（诚实声明 G3-003）：
 * collectRecords(limit, statusFilter) 合并内存(running) + 磁盘(sessions/*.jsonl 重建)。
 * 磁盘源天然跨 session 可见——/new /resume /fork 后前 session 的终态 record 仍在
 * sessions 目录里（直到 30 天 GC）。内存源仅当前 session 的 running record。
 * 不新增 sessionId 到 ExecutionRecord（YAGNI，修跨 session 清理是独立问题）。
 */

/** exhaustiveness 兜底：default 分支把 status 收敛为 never，ExecutionStatus 加态时 tsc 报错。 */
function assertNever(value: never): string {
  return String(value);
}

/**
 * 内部 ExecutionStatus → 对外 state 映射（设计决策 10 细则 3）。
 * v4 B-1 两态收敛后的真实映射只有两条：
 *   running → active / closed → ended（closed 统一终态，含 cancelled）
 * ExternalState 仍声明 waiting/error 四态联合（对外契约不变），但当前状态机不产生
 * 这两个值——它们是历史多态映射（idle→waiting / failed+crashed→error）的遗留声明。
 * 未来内部加态必须扩展此处，漏加会在 default 分支编译报错（而非静默返回 undefined
 * 让 state 字段以无主值进入 listResponse JSON）。
 */
export function mapExternalState(status: ExecutionStatus): ExternalState {
  switch (status) {
    case "running":
      return "active";
    case "closed":
      // v4 B-1: closed 统一终态（含 cancelled）。对外映射为 ended。
      return "ended";
    default:
      throw new Error(`mapExternalState: unhandled ExecutionStatus ${assertNever(status)}`);
  }
}

/** SubagentRecord → SubagentListItem（state 四态主字段 + status 调试字段，duration 实时计算）。
 *  [v4 A-6] 新增 parent/resumable/closedReason：parent 从 record.parentRecordId 派生
 *  （配合 A-5 直接父守卫），resumable 从 isResumable 派生（B-1「可续聊」对外表达），
 *  closedReason 透传（SP-4 级联关闭告知替代 before_agent_start 注入）。
 *  agent 是 GUI/TUI list 共用的显示名——取 basename 短名（displayAgentName），
 *  完整路径保留在 record.agent（数据层）。 */
export function recordToListItem(r: SubagentRecord): SubagentListItem {
  return {
    subagentId: r.id,
    agent: displayAgentName(r.agent),
    slug: r.slug,
    state: mapExternalState(r.status),
    status: r.status,
    mode: r.mode,
    duration: computeElapsedSeconds(r),
    model: r.model,
    totalTokens: r.totalTokens,
    sessionFile: r.sessionFile,
    parent: r.parentRecordId,
    resumable: isResumable(r),
    closedReason: r.closedReason,
  };
}

// ============================================================
// start handler
// ============================================================

export async function startHandler(
  service: SubagentService,
  input: StartHandlerInput | undefined,
  signal: AbortSignal | undefined,
  ctxModel?: ModelInfo,
): Promise<StartHandlerResult> {
  if (!input) throw new Error(
    "action:'start' requires task and slug (top-level fields). " +
    'Correct: {"action":"start","task":"<your task>","slug":"<kebab-case>"}',
  );
  // task 必填 + 空白校验（G-008）
  const task = input.task?.trim();
  if (!task) throw new Error(
    "task is required for action:'start' (top-level field, must not be whitespace-only). " +
    'Correct: {"action":"start","task":"...","slug":"..."}',
  );
  // slug 必填 + 空白校验 + 长度校验（≤ SLUG_MAX_LENGTH 字符）
  const slug = input.slug?.trim();
  if (!slug) throw new Error(
    "slug is required for action:'start' (top-level field, must not be whitespace-only). " +
    'Correct: {"action":"start","task":"...","slug":"<kebab-case>"}',
  );
  if (slug.length > SLUG_MAX_LENGTH) throw new Error(`slug must be ≤${SLUG_MAX_LENGTH} chars (got ${slug.length}). Shorten to a kebab-case label, e.g. "fix-login", "extract-urls".`);

  const handle = await service.execute({
    task,
    slug,
    agent: input.agent,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    skillPath: input.skillPath,
    appendSystemPrompt: input.appendSystemPrompt,
    schema: input.schema,
    maxTurns: input.maxTurns,
    graceTurns: input.graceTurns,
    fork: input.fork,
    worktree: input.worktree,
    cwd: input.cwd,
    conversation: input.conversation,
    idleTimeoutMs: input.idleTimeoutMs,
    ctxModel,
    signal,
    // background detached 运行，完成由 notify 驱动新 turn。
  });

  return {
    kind: "bg",
    subagentId: handle.subagentId,
    sessionFile: handle.sessionFile,
    slug: handle.details.slug,
    response: {
      status: "running",
      mode: "background",
      message: BG_MESSAGE,
    },
  };
}

// ============================================================
// list handler
// ============================================================

export function listHandler(
  service: SubagentService,
  input: ListHandlerInput | undefined,
): ListHandlerResult {
  const includeFinished = input?.includeFinished === true;
  // limit 夹紧：默认 20，范围 [1, 100]
  const rawLimit = input?.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, MAX_LIST_LIMIT));

  // collectRecords 是 service 核心能力：statusFilter 决定 running-only 还是全部。
  // 防截断（先多取再过滤）已下沉到 store 层——这里直接传 limit + filter。
  const filter = includeFinished ? "all" : "running";
  const all = service.collectRecords(limit, filter);
  // [perf] collectRecords 磁盘源是 light（无 totalTokens/model 等）：SubagentListItem 对
  // LLM 消费方暴露 totalTokens/model，逐项 getFullRecord 补全（per-file 缓存，仅首次
  // 全量解析；显式 tool 调用非渲染热路径，成本可接受）。
  const items: SubagentListItem[] = all.map((r) =>
    recordToListItem(service.getFullRecord(r.id) ?? r),
  );
  const running = items.filter((i) => i.status === "running").length;

  return { response: { running, items } };
}

// ============================================================
// cancel handler
// ============================================================

export async function cancelHandler(
  service: SubagentService,
  input: CancelHandlerInput | undefined,
): Promise<CancelHandlerResult> {
  const id = input?.subagentId?.trim();
  if (!id) throw new Error("cancelParam.subagentId is required for action:'cancel'");

  // step 1: id 不存在（findRecord 只查内存 running record，不从 session.jsonl 重建）
  const rec = service.findRecord(id);
  if (!rec) {
    // [S-19] MF-1 全树可见后，list/completion 可能列出其他进程（父/兄弟）的 running record
    //（collectRecords 扫共享 sessionsDir 按 rootSessionId 过滤，跨进程互相可见），而 cancel
    // 只作用于本进程内存 record。区分两种失败，避免「may have finished」误导（该 record 正
    // 被列出且未 finished，只是不属于本进程内存）。仅文案区分，不改 cancel 作用域。
    const treeRec = service.collectRecords(DEFAULT_LIST_LIMIT, "all").find((r) => r.id === id);
    if (treeRec && treeRec.status === "running") {
      throw new Error(
        `Subagent record "${id}" is running but owned by another process in the tree ` +
          `(it was spawned by a different subagent process) — this process cannot cancel it; ` +
          `cancel only works for subagents spawned by the current process.`,
      );
    }
    throw new Error(`No subagent record with id "${id}". It may have finished — use action:'list' with includeFinished:true to verify.`);
  }
  // step 2: controller 检查（controller 为 undefined 表示 record 已终态或未启动）
  if (rec.mode !== "background") {
    throw new Error(`Cannot cancel subagent ${id} (unsupported mode: ${rec.mode})`);
  }
  // 对话模式 cancel = close(force:true) 别名（设计决策 5）：chatMode record（running/idle）
  // 走 close 行为路径（idle 终态化 done；running 立即 SIGTERM cancelled），
  // 返回 cancel 响应（向后兼容 cancel action 的返回类型）。非 chatMode 保持现有 cancel 行为。
  if (rec.chatMode) {
    const chatRecord = service.getRecordForAction(id);
    await service.closeSubagent(chatRecord, true);
    return { subagentId: id, response: { cancelled: true } };
  }
  // step 3: service.cancel boolean（list-view 契约不变）；false = 已终态（CAS 抢锁失败）。
  // 注意：不嵌入 rec.status——findRecord 快照可能已过期（TOCTOU：cancel 期间 detached
  // 路径 CAS 到 done/failed）。重新查当前状态，避免「status: running」与「already finished」矛盾。
  if (!service.cancel(id)) {
    // CAS 失败 = record 在 cancel 期间被 detached 路径 finalize（done/failed）。
    // re-query 查当前真实状态。终态 record 被 archive 立即移出内存，
    // 诚实报告 "unknown (evicted from memory)" 而非回落到可能过期的 rec.status（BL-3）。
    const now = service.findRecord(id);
    const statusDesc = now ? now.status : "unknown (evicted from memory)";
    throw new Error(`Subagent ${id} could not be cancelled (it likely just finished; status: ${statusDesc})`);
  }
  return { subagentId: id, response: { cancelled: true } };
}

// ============================================================
// message handler（M2-B3 对话模式续聊/插入）
// ============================================================

export interface MessageHandlerInput {
  subagentId?: string;
  text?: string;
  interrupt?: boolean;
}

/** message 领域对象（adapter 包成 messageResponse）。 */
export type MessageHandlerResult = {
  kind: "message";
  subagentId: string;
  response: MessageResponse;
};

/**
 * message action handler：向对话模式 subagent 续聊/插入消息。
 *
 * 状态 × interrupt 自动映射（agent 只表达意图）：
 *   running → deliverMessage 热路径（进程活：prompt + streamingBehavior，interrupt=true
 *             抢占 / false 排队，pi 权威裁决 busy/idle）
 *   进程死  → deliverMessage 冷路径（resumeRound 重开 session + prompt，interrupt 自动
 *             退化，agent 无感）
 *   终态    → throw ended（正常路径不命中——终态 record 已 archive，getRecordForAction 先 throw not found）
 * （旧 deliverToRunning busy 投递已删除——SP-5 upgrade 后 running 恒走 deliverMessage）
 *
 * 归属守卫（决策 3）：getRecordForAction 内部校验 rootSessionId。
 *
 * @throws Error subagentId/text 缺失 / 不存在或非本 session 所有 / 已结束
 */
export async function messageHandler(
  service: SubagentService,
  input: MessageHandlerInput | undefined,
): Promise<MessageHandlerResult> {
  const id = input?.subagentId?.trim();
  if (!id) throw new Error("messageParam.subagentId is required for action:'message'");
  const text = input?.text?.trim();
  if (!text) throw new Error(
    "messageParam.text is required for action:'message' (must not be whitespace-only). " +
    'Correct: {"action":"message","messageParam":{"subagentId":"sa-...","text":"your follow-up"}}',
  );
  const interrupt = input?.interrupt === true;

  // 归属守卫（决策 3）：getRecordForAction 内部校验 rootSessionId
  const record = service.getRecordForAction(id);

  // SP-5 one-shot upgrade：非 chatMode 的 active record（running/idle）收到 message 时
  // 自动升级为 chatMode，后续走 deliverMessage 统一投递路径（热路径或冷路径 resume）。
  // closed/cancelled 终态 record 不可 upgrade（getRecordForAction 已抛 not found）。
  // chatMode 是 ExecutionRecord 的 readonly 字段，用 Mutable<T> 显式断言绕过 readonly 约束（upgrade 语义）。
  // Object.assign 隐式绕过 readonly 不可追踪，改为单字段显式赋值。
  // [v4 A-3] 进程内 upgrade 入口（SP-5）——one-shot 首条 message 触发 upgrade 置位
  // chatMode=true。与 subagent-service.ts getRecordForAction 磁盘重建（跨重启恢复入口）
  // 分工：本入口服务进程内 one-shot，跨重启路径恒被 getRecordForAction 磁盘重建绕过
  // （该处无条件 chatMode=true）。改动这两处必须协同，带 S3 回归。
  if (!record.chatMode && record.status === "running") {
    type Mutable<T> = { -readonly [K in keyof T]: T[K] };
    (record as Mutable<ExecutionRecord>).chatMode = true;
  }

  // [V2 决策 3] chatMode 统一投递：按进程死活分流（热路径 prompt+streamingBehavior / 冷路径 resume），
  // 不按 record.status（V2 进程长驻，idle 态进程仍活，续聊走热路径 prompt 而非重开 session）。
  // SP-5：upgrade 后 record.chatMode 已为 true，统一进此分支。
  if (record.chatMode) {
    await service.deliverMessage(record, text, interrupt);
  } else {
    // 终态（closed/cancelled）：防御性兜底（终态 record 已 archive，正常走 not found）
    throw new Error(
      `subagent ${id} has ended (status: ${record.status}), cannot message. ` +
      `Recovery: use action:'close' to clean up, then action:'start' a new subagent.`,
    );
  }
  return { kind: "message", subagentId: id, response: { delivered: true } };
}

// ============================================================
// close handler（M2-B3 对话模式结束）
// ============================================================

export interface CloseHandlerInput {
  subagentId?: string;
  force?: boolean;
}

/** close 领域对象（adapter 包成 closeResponse）。 */
export type CloseHandlerResult = {
  kind: "close";
  subagentId: string;
  response: CloseResponse;
};

/**
 * close action handler：结束 subagent（对话模式为主，one-shot 同样支持）。
 *
 * force 语义（设计决策 5/10，v4 B-1 两态收敛 + M5 修正）：
 *   force:false（默认）= 优雅关闭——
 *     无在跑轮（等待续聊 timer armed / 无活进程）→ 立即终态化（closed + user-close，回收保活进程）
 *     有活进程在跑轮 → 置 closeAfterRound，轮完成时终态化（chatMode 消费点 onRoundSettled，
 *     one-shot 在 runAndFinalize 轮完成分支）——返回 {closed:true} 即承诺轮结束后资源已释放
 *   force:true = 立即终止——running 立即 SIGTERM（cancelBackground 显式 kill）+ closed+cancelled
 *
 * 行为分流委托 service.closeSubagent（归属守卫由 getRecordForAction 把关）。
 * 已终态 record 由 getRecordForAction throw not found（「已结束的不能再操作」语义）。
 */
export async function closeHandler(
  service: SubagentService,
  input: CloseHandlerInput | undefined,
): Promise<CloseHandlerResult> {
  const id = input?.subagentId?.trim();
  if (!id) throw new Error("closeParam.subagentId is required for action:'close'");
  const force = input?.force === true;

  // 归属守卫（决策 3）+ 行为分流（service.closeSubagent）
  const record = service.getRecordForAction(id);
  await service.closeSubagent(record, force);

  return { kind: "close", subagentId: id, response: { closed: true } };
}

// ============================================================
// adapter（领域对象 → SubagentToolResult + {content, details}）
// ============================================================

/**
 * action ↔ domain 配对的承重类型（替代三处松散 `as`）。
 * 调用方必须传匹配的 {action, domain}——TS 在调用点校验，错配编译报错。
 */
type AdapterInput =
  | { action: "start"; domain: StartHandlerResult }
  | { action: "list"; domain: ListHandlerResult }
  | { action: "cancel"; domain: CancelHandlerResult }
  | { action: "message"; domain: MessageHandlerResult }
  | { action: "close"; domain: CloseHandlerResult };

export function adapter(
  input: AdapterInput,
  ctx?: GuiContext,
): AgentToolResult<SubagentToolResult> {
  const { action } = input;
  let result: SubagentToolResult;
  if (action === "start") {
    const d = input.domain;
    // MF-3（决策 10 细则 4）：LLM content (text) 用 null 瘦身，防诱导 agent 用 read 绕过工具
    // 直接读 session 文件。真实 sessionFile 仅 details 保留（供 GUI/程序化消费）。
    result = { action, subagentId: d.subagentId, sessionFile: null, slug: d.slug, bgResponse: d.response };
  } else if (action === "list") {
    result = { action, subagentId: null, sessionFile: null, listResponse: input.domain.response };
  } else if (action === "cancel") {
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, cancelResponse: input.domain.response };
  } else if (action === "message") {
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, messageResponse: input.domain.response };
  } else {
    // action === "close"
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, closeResponse: input.domain.response };
  }

  // content JSON：LLM 看的结构化结果（schema 模式 parsedOutput 作为嵌套 JSON 值可接受）。
  const text = JSON.stringify(result);

  // MF-3：start 的 LLM content 已瘦身（sessionFile:null），details 保留真实 sessionFile 供 GUI/程序化消费。
  // result 已是合法 SubagentToolResult（start 变体 sessionFile:null）；start 时重建一个带真实 sessionFile 的副本。
  let detailsBase: SubagentToolResult = result;
  if (action === "start") {
    const d = input.domain;
    detailsBase = { action: "start", subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, slug: d.slug, bgResponse: d.response };
  }

  // GUI 协议：RPC 模式下附加结构化渲染数据（union 各成员已声明 __gui__?，无需强转）
  const details: SubagentToolResult = ctx && isGuiCapable(ctx)
    ? { ...detailsBase, __gui__: guiResult(buildGuiComponent(input, result)) }
    : detailsBase;

  // [W3 修复] list action 追加 reminder text block：LLM 调 list 时提醒不要轮询。
  // reminder 作为第二个 text block（独立追加，不污染 details/JSON schema）。
  // 只有 list 触发——start 的 reminder 已在 BG_MESSAGE 里；cancel 无需。
  const reminder = action === "list"
    ? "\n\nReminder: Subagent completion is auto-notified via injected message (deliverAs: steer). Do NOT poll in a loop — there is no poll action. Use action:'list' only when you concretely need state, then continue working or stop."
    : "";

  return {
    content: [{ type: "text", text }, { type: "text", text: reminder }],
    details,
  };
}

/**
 * 按 input.action 构造对应的 GuiComponent。
 * 分支判定用 discriminated key（input.action）而非独立宽类型参数——TS 自动
 * 收窄 input.domain 到对应 HandlerResult，无需 `as` 断言（与 adapter() 同款模式）。
 */
export function buildGuiComponent(
  input: AdapterInput,
  _result: SubagentToolResult,
) {
  const { action } = input;
  if (action === "start") {
    // subagent-trace 多层语义（agent名+slug+状态）用 card(stats-line) 组合表达。
    // 利用 input.domain 的身份信息，让并发 subagent 可区分。
    const d = input.domain;
    return guiComponent("card", {
      header: d.slug ? `${d.slug}` : d.subagentId.slice(0, SUBAGENT_ID_PREVIEW),
      body: [guiComponent("stats-line", {
        items: [{ value: "running", severity: "ok" }],
      })],
    });
  }
  if (action === "list") {
    const listResp = input.domain;
    return guiComponent("list-tree", {
      items: listResp.response.items.map((it) => ({
        label: it.slug ? `${it.agent} · ${it.slug} · ${it.subagentId}` : `${it.agent} · ${it.subagentId}`,
        status: mapRunStatus(it.status),
        icon: mapRunIcon(it.status),
      })),
    });
  }
  if (action === "message") {
    return guiComponent("stats-line", {
      items: [{ label: "messaged", value: input.domain.subagentId, severity: "ok" }],
    });
  }
  if (action === "close") {
    return guiComponent("stats-line", {
      items: [{ label: "closed", value: input.domain.subagentId, severity: "warn" }],
    });
  }
  // cancel（fall-through：前四分支已 return）。
  // 穷尽检查（同 mapExternalState 的 assertNever 先例）：AdapterInput 未来新增
  // action 时，action 在此不再收窄为 "cancel"，assertNever 的 never 参数处编译
  // 报错——防止新分支静默落入 cancelled 渲染。
  if (action !== "cancel") {
    throw new Error(`buildGuiComponent: unhandled action ${assertNever(action)}`);
  }
  return guiComponent("stats-line", {
    items: [{ label: "cancelled", value: input.domain.subagentId, severity: "warn" }],
  });
}
