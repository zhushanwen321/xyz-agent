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

import { SLUG_MAX_LENGTH } from "@zhushanwen/subagent-core/execution/execute-options-mapper.ts";
import { computeElapsedSeconds, projectOutcome } from "@zhushanwen/subagent-core/execution/execution-record.ts";
import { isResumable } from "@zhushanwen/subagent-core/execution/lifecycle-predicates.ts";
import type { ExecutionRecord } from "@zhushanwen/subagent-core/execution/types.ts";
import type { ModelInfo } from "@zhushanwen/subagent-core/execution/model-resolver.ts";
import type { SubagentService } from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import { displayAgentName } from "@zhushanwen/subagent-core/shared/agent-ref.ts";
import type {
  BgResponse,
  CancelResponse,
  CloseResponse,
  ExecutionStatus,
  ExternalState,
  ForkFromResponse,
  ListResponse,
  MessageResponse,
  SubagentListItem,
  SubagentRecord,
  SubagentToolResult,
} from "@zhushanwen/subagent-core/execution/types.ts";
import { ResurrectDeniedError } from "@zhushanwen/subagent-core/execution/types.ts";
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

/** 通知投递契约回显恒值（U1 预置，U2 账本兑现，见 BgResponse.notifyContract）。 */
const NOTIFY_CONTRACT = "ledger+at-least-once" as const;

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
  /**
   * 空闲超时毫秒数（仅 conversation 模式有意义，覆盖默认 5min）。
   * 显式传 0/负数 = 禁用 idle GC（不挂 timer）；不传走 env/默认优先级。
   */
  idleTimeoutMs?: number;
  /** 执行引擎（D4 三层路由第一层：本参数 > agent frontmatter engine > config defaultEngine）。 */
  engine?: string;
}

/** start 领域对象（adapter 包成 bgResponse）。 */
export type StartHandlerResult = {
  kind: "bg";
  subagentId: string;
  sessionFile: string | undefined;
  /** 短标签，来自 record（handle.details.slug）。用于 result 行展示。 */
  slug: string;
  /**
   * registry 全等回显（U1）：handle.details.model = record.model = `${provider}/${id}`，
   * 源头是 resolveModel 裁决放行的条目——通过校验 = 子进程必然按此名执行。
   */
  model: string;
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
// [v8.5 A1/B] message 拒绝文案分流 + fork-from 引导语框架
// ============================================================

/**
 * [v8.5 A1] message 拒绝时的可行动文案分流。
 *
 * 背景：getRecordForAction 冷查只认 status==='running'（SP-2 可续聊重建），任何终态/
 * 异归属记录都落到同一个「not found or not owned」错误，把两类完全不同的场景混为一谈：
 *   - user-close/cancelled：用户主动告别，记录真没了 → 引导 start 新的
 *   - parent-shutdown/gc/orphan 等：父会话重启/进程退出导致的断联，对话 jsonl 完好，
 *     resume/fork 基建现成 → 引导 fork-from 从旧记录接续
 *
 * 分流规则（消费方是 LLM，保持正交简单）：
 *   - 找不到记录 → 原样透传 getRecordForAction 错误（id 打错最常见，原文案最准）
 *   - closed + user-close/cancelled →「已主动关闭，无法续聊」文案
 *   - 其余（closed 其他 reason / running 但异归属）→「断联可接续」文案
 */
export function endedMessageGuard(service: SubagentService, id: string, original: unknown): Error {
  // [v8.5 D] 透明重生守卫拒绝（worktree/异进程占用）原样透传——错误自带完整行动语言，
  // 若被下方 fork-from 指引改写会误导 agent 走已被判死的通道（types.ts 契约声明）。
  if (original instanceof ResurrectDeniedError) return original;
  let snap: SubagentRecord | undefined;
  try {
    snap = service.lookupRecordAnyState(id);
  } catch {
    snap = undefined;
  }
  if (!snap) {
    return original instanceof Error ? original : new Error(String(original));
  }
  if (snap.status === "closed") {
    if (snap.closedReason === "cancelled" || snap.closedReason === "user-close") {
      return new Error(
        `subagent ${id} was deliberately closed by user (closedReason: ${snap.closedReason}) — ` +
        `it cannot be messaged or resumed; nothing can reattach to it. ` +
        `Recovery: start a new subagent (action:'start'); use action:'list' with includeFinished:true to review its final output.`,
      );
    }
    return new Error(
      `subagent ${id} is ended but reconnectable (closedReason: ${snap.closedReason ?? "unknown"}` +
      `${describeClosedContext(snap)}). Its conversation history is intact at ${snap.sessionFile ?? "(session file unavailable)"}. ` +
      `Recovery: resume from that history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"${id}"}}, ` +
      `or read key points directly from the session file.`,
    );
  }
  // running 但未通过 getRecordForAction：记录属于当前进程外的另一个 session 树
  //（主会话重启前的遗留态，或其他并发 pi 进程的活跃 subagent）。无论哪种，历史
  // jsonl 只读安全，fork-from 快照接续均有效。
  return new Error(
    `subagent ${id} is alive but belongs to a different session tree than this one` +
    `${describeClosedContext(snap)}. You cannot message it from here. ` +
    `Recovery: branch from its history with {"action":"fork-from","forkFromParam":{"sourceSubagentId":"${id}"}}` +
    `${snap.sessionFile ? ` (source session: ${snap.sessionFile})` : ``}; otherwise start a new subagent.`,
  );
}

/** 终态快照的上下文人话短语（仅作补充描述，主分支逻辑在 endedMessageGuard）。 */
function describeClosedContext(r: SubagentRecord): string {
  switch (r.closedReason) {
    case "parent-shutdown":
      return " — it was disconnected when the previous parent session exited";
    case "parent-fork":
      return " — it was detached when the previous parent session forked";
    case "parent-new":
      return " — it was detached when the previous parent session switched";
    case "disconnected":
      return " — it ended in a previous session (exact cause unknown)";
    default:
      return "";
  }
}

/**
 * [v8.5 B] fork-from 开场引导语框架（prompt 未指定时注入）：先从继承的历史重建状态
 * 再继续，防猜。
 */
const FORK_FROM_DEFAULT_PROMPT =
  "You are taking over work from a previous subagent whose full conversation history you inherited (--fork). " +
  "First reconstruct state from that history: list what was already done, decided, and left unfinished (a few bullet lines). " +
  "Then continue the remaining work to completion.";

/**
 * [v8.5 B] 有显式接续指令时的包裹框架：指令在前、上下文重建要求在后——指令首见即达，
 * 不湮没在元说明里（弱模型友好）。
 */
function wrapForkFromPrompt(prompt: string): string {
  return (
    prompt.trim() +
    "\n\n(You are continuing a previous subagent's inherited conversation via --fork. " +
    "Reconstruct state from that history first — what was done, decided, and remains — then execute the instruction above.)"
  );
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
 *  [v4 A-6] 新增 parent/resumable：parent 从 record.parentRecordId 派生（配合 A-5 直接父
 *  守卫），resumable 从 isResumable 派生（B-1「可续聊」对外表达）。
 *  [U3 C-outcome] 新增 outcome 一等终态语义（projectOutcome 唯一出口）；closedReason
 *  退出对外 JSON（保留为 record 内部诊断字段），对外成败判读收口到 outcome，消费方
 *  零手写推导（三处同构 switch 已收敛删除）。
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
    outcome: projectOutcome(r),
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
    engine: input.engine,
    ctxModel,
    signal,
    // background detached 运行，完成由 notify 驱动新 turn。
  });

  return {
    kind: "bg",
    subagentId: handle.subagentId,
    sessionFile: handle.sessionFile,
    slug: handle.details.slug,
    // [U1] registry 全等回显：record.model 由 resolved（裁决放行条目）拼接，原样透出。
    model: handle.details.model,
    response: {
      status: "running",
      mode: "background",
      message: BG_MESSAGE,
      notifyContract: NOTIFY_CONTRACT,
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

/** message 领域对象（adapter 包成 messageResponse）。
 *  slug 来自 record（GUI /subagents message 通道的留痕 details 需要，设计 §3.3.3），
 *  避免调用方二次 getRecordForAction 查询。 */
export type MessageHandlerResult = {
  kind: "message";
  subagentId: string;
  slug: string;
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

  // 归属守卫（决策 3）：getRecordForAction 内部校验 rootSessionId。
  // [v8.5 A1] 拒绝时经 endedMessageGuard 分流：找不到 → 原错误；user-close/cancelled
  // → 「已主动关闭」；断联/已完成/异归属 → fork-from 可行动指引。仅 message action
  // 升级文案——close/cancel 维持原语义（它们不需要恢复通道）。
  let record: ExecutionRecord;
  try {
    record = service.getRecordForAction(id, { allowReconnect: true });
  } catch (err) {
    throw endedMessageGuard(service, id, err);
  }

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
  return { kind: "message", subagentId: id, slug: record.slug, response: { delivered: true } };
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
// fork-from handler（[v8.5 B] 断联恢复通道）
// ============================================================

export interface ForkFromHandlerInput {
  sourceSubagentId?: string;
  prompt?: string;
}

/** fork-from 领域对象（adapter 包成 forkFromResponse）。 */
export type ForkFromHandlerResult = {
  kind: "fork-from";
  /** 新 subagent 的 record id（后续续聊用 action:'message'）。 */
  subagentId: string;
  /** 作为 --fork 继承源的旧记录 session 文件。 */
  sourceSessionFile: string;
  response: ForkFromResponse;
};

/**
 * fork-from action handler：从旧 subagent 的会话历史 spawn 新 id 接续。
 *
 * 用于 subagent 因会话重启/进程退出而断联后的恢复：新进程以 --fork 指向旧 session
 * 文件（copy-on-write 建分支会话），继承全部对话历史；源文件只读不续写。
 * 旧记录本身不动——closed 单向状态机不变量、tryTransition 语义均不触碰。
 *
 * 守卫链（拒绝原因与行动语言对齐现有 MF-4 风格）：
 *   1. 本进程内存 running → 还活着，应走 message（防双写同一子 session 文件）
 *   2. 不存在            → 引导 list 确认
 *   3. 异进程活跃（磁盘 .alive pid 存活 / running 快照）→ 别处正跑，不可从此接续
 *      （同 id 双写风险；等待其结束或在其所属会话内操作）
 *   4. tombstone/cancelled → 用户主动取消，真没了（不提供接续通道）
 *   5. worktree 记录     → checkout 不可复用，fork 子进程 cwd 会回落主仓破坏隔离
 *      （对齐 deliverMessage 的 hadWorktree 守卫语义）
 *   6. 无子 session 文件  → 无历史可继承（entry-only 孤儿：spawn 窗口期中断）
 *
 * @throws Error 各守卫命中 / service.execute 失败（引擎不支持等）
 */
export async function forkFromHandler(
  service: SubagentService,
  input: ForkFromHandlerInput | undefined,
): Promise<ForkFromHandlerResult> {
  const id = input?.sourceSubagentId?.trim();
  if (!id) throw new Error("forkFromParam.sourceSubagentId is required for action:'fork-from'");
  const prompt = input?.prompt?.trim() ?? "";
  const task = prompt ? wrapForkFromPrompt(prompt) : FORK_FROM_DEFAULT_PROMPT;

  const source = assertAndLookupForkFromSource(service, id);

  // slug 派生：源 slug + -resumed 后缀（截断到上限）。仅展示标签，不需唯一。
  const baseSlug = (source.slug || source.agent || "resumed").slice(0, SLUG_MAX_LENGTH - "-resumed".length);
  const handle = await service.execute({
    task,
    slug: `${baseSlug}-resumed`,
    forkFromSessionFile: source.sessionFile,
  });

  return {
    kind: "fork-from",
    subagentId: handle.subagentId,
    sourceSessionFile: source.sessionFile,
    response: { newSubagentId: handle.subagentId, sourceSessionFile: source.sessionFile },
  };
}

/** forkFromHandler 的守卫链（fork-from handler doc 的守卫 1–6 原样提取）：按序校验
 *  源记录可接续，命中即抛带行动语言的 Error；全部通过则返回源 SubagentRecord
 *  （守卫 6 已保证 sessionFile 非空，返回类型随之收窄）。 */
function assertAndLookupForkFromSource(service: SubagentService, id: string): SubagentRecord & { sessionFile: string } {
  // 守卫 1：本进程内存 running —— 直接 message 即可，fork-from 会双写其 session 文件。
  if (service.findRecord(id)) {
    throw new Error(
      `subagent ${id} is still active in this process — use action:'message' to continue it directly. ` +
      `If you want a parallel branch from its history, close it first (action:'close'), then fork-from.`,
    );
  }

  // 守卫 2：全态查找（内存 archived + 磁盘重建）。
  const source = service.lookupRecordAnyState(id);
  if (!source) {
    throw new Error(
      `No subagent record with id "${id}". It may never have existed or been garbage-collected — ` +
      `use action:'list' with includeFinished:true to verify the id.`,
    );
  }

  // 守卫 3：异进程活跃（磁盘分支 3 externalInstance = 另一进程的活 pid marker）。
  // 双写防护：fork 虽 copy-on-write（历史 jsonl 只读），但源仍在异进程运行时接续容易
  // 读到半截历史，等它结束再接更安全。判据只认 externalInstance（真实活 pid 探针
  // 命中），不拦 status==='running' 的快照——后者含 B-1 跨重启回退重建的 running 记录
  //（无活 pid，历史已完整落盘），它们正是 endedMessageGuard 指引 fork-from 的目标；
  // 拦了会让 agent 在「建议 fork-from」与「fork-from 拒绝 running」两条错误间死循环。
  if (source.externalInstance !== undefined) {
    throw new Error(
      `subagent ${id} is still running in another process (alive pid marker present). ` +
      `Recovery: wait until it finishes, or operate it in its own session; then retry fork-from.`,
    );
  }

  // 守卫 4：主动告别（cancelled tombstone / user-close 正式关闭）——close 语义无旁路：
  // fork-from 与 message 一致拒绝（guard 一致性规格），文案升级为统一「主动关闭」形态
  // （含 closedReason 显式列入），与 deliverMessage 的 X 分支同语系不同落地（此处强调不可 branch）。
  if (source.status === "closed" && (source.closedReason === "cancelled" || source.closedReason === "user-close")) {
    throw new Error(
      `subagent ${id} was deliberately closed by user (closedReason: ${source.closedReason}) — ` +
      `deliberately-closed records cannot be resumed or branched from; nothing can reattach to them. ` +
      `Recovery: start a fresh subagent (action:'start'); use action:'list' with includeFinished:true to review its final output.`,
    );
  }

  // 守卫 5：worktree 记录 —— WorktreeHandle 不可序列化，checkout 已被 reaper/cleanup
  // 回收；fork 子进程若复用旧路径会回落主 repo（破坏文件隔离）。与 deliverMessage 的
  // hadWorktree 守卫同一判据同一理由。
  if (source.worktree === true) {
    throw new Error(
      `subagent ${id} was created with worktree isolation; that binding was lost when its parent process ended. ` +
      `Resuming from its history would run outside the original worktree isolation. ` +
      `Recovery: start a new subagent with action:'start' and carry over key findings manually ` +
      `(read ${source.sessionFile ?? "its session file"} if needed).`,
    );
  }

  // 守卫 6：无子 session 文件（entry-born 孤儿：spawn 窗口期中断，从未开跑）。
  const sessionFile = source.sessionFile;
  if (!sessionFile) {
    throw new Error(
      `subagent ${id} has no child session file to inherit from (it never started successfully). ` +
      `Recovery: start a fresh subagent (action:'start') describing the task again.`,
    );
  }

  return { ...source, sessionFile };
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
  | { action: "close"; domain: CloseHandlerResult }
  | { action: "fork-from"; domain: ForkFromHandlerResult };

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
    // [U1] model 为 registry 全等回显（放行即全等）。
    result = { action, subagentId: d.subagentId, sessionFile: null, slug: d.slug, model: d.model, bgResponse: d.response };
  } else if (action === "list") {
    result = { action, subagentId: null, sessionFile: null, listResponse: input.domain.response };
  } else if (action === "cancel") {
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, cancelResponse: input.domain.response };
  } else if (action === "message") {
    result = { action, subagentId: input.domain.subagentId, sessionFile: null, messageResponse: input.domain.response };
  } else if (action === "fork-from") {
    // MF-3 同款瘦身：sourceSessionFile 真实路径只在 forkFromResponse 内层（LLM 接续
    // 不需要拼路径，需要时 list/details 可取）；顶层 sessionFile 保持 null 一致性。
    const d = input.domain;
    result = { action, subagentId: d.subagentId, sessionFile: null, forkFromResponse: d.response };
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
    detailsBase = { action: "start", subagentId: d.subagentId, sessionFile: d.sessionFile ?? null, slug: d.slug, model: d.model, bgResponse: d.response };
  }

  // GUI 协议：RPC 模式下附加结构化渲染数据（union 各成员已声明 __gui__?，无需强转）
  const details: SubagentToolResult = ctx && isGuiCapable(ctx)
    ? { ...detailsBase, __gui__: guiResult(buildGuiComponent(input, result)) }
    : detailsBase;

  // [W3 修复] list action 追加 reminder text block：LLM 调 list 时提醒不要轮询。
  // reminder 作为第二个 text block（独立追加，不污染 details/JSON schema）。
  // 只有 list 触发——start 的 reminder 已在 BG_MESSAGE 里；cancel 无需。
  const reminder = action === "list"
    ? "\n\nReminder: Subagent completion is auto-notified via auto-injected message (turn-triggering on idle). Do NOT poll in a loop — there is no poll action. Use action:'list' only when you concretely need state, then continue working or stop." // g4-allow: 契约文案——reminder 字符串描述自动注入通道（triggerTurn 单通道，U2/D5 无 deliverAs），非实际投递调用
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
  if (action === "fork-from") {
    return guiComponent("stats-line", {
      items: [
        { label: "forked-from", value: input.domain.sourceSessionFile },
        { label: "new subagent", value: input.domain.subagentId, severity: "ok" },
      ],
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
