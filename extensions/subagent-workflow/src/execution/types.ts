// src/types.ts
//
// 跨层共享的核心类型契约。Core/Runtime/TUI 三层均可 import 本文件。
//
// 分层铁律：
//   - Core 不 import Runtime/TUI（零 Pi 依赖，可单测）
//   - Runtime 编排 Core，产出 Details/Record 给 TUI
//   - TUI 只读 Record/Details 快照，永不持有可变引用

import type { GuiRenderResult } from "@xyz-agent/extension-protocol";

import type { ModelInfo, ModelRegistryLike } from "./model-resolver.ts";

// ============================================================
// 全局常量
// ============================================================

/**
 * 未显式指定 agent 时的兌底名。
 *
 * 必须是真实存在、可被 agentRegistry 发现的 agent（用户 agentDir 内置的通用 agent）。
 * Service 层（resolveIdentity）与 TUI 层（extractAgentName）共用此常量，保证
 * 「调用时显示的名」与「实际加载的 agent.md」一致。
 *
 * [HISTORICAL] 旧实现两处各硬编码：service 用 "default"（虚构名），format 用
 * "worker"（真实但不是兌底语义）。导致不传 agent 时，block 标题显示 worker，
 * 但实际执行兌底逻辑不一致。统一为 general-purpose 后名实相符。
 */
export const DEFAULT_AGENT_NAME = "general-purpose";

// ============================================================
// 执行状态机
// ============================================================

/**
 * 唯一执行状态。所有路径共用。v4 B-1 两态收敛：旧 idle 折入 running、
 * 旧 cancelled 折入 closed（closedReason='cancelled' 区分）。
 *
 * running = 活跃态。含两种子态（由派生谓词区分，见 lifecycle-predicates.ts）：
 *   - 对话模式等待续聊（旧 idle）：进程可能保活（isIdle=hasIdleTimer）或已回收
 *     待冷路径 resume（isResumable=running && 无活进程句柄）。
 *   - 正在执行（有活进程句柄）。
 *
 * closed = 统一终态（done/failed/crashed/cancelled 合并）。具体关闭原因由
 * {@link ClosedReason} 子枚举表达（如 user-close / gc / cancelled / parent-shutdown）。
 * ExecutionRecord.closedReason 携带 L2 原因，投影层按需派生对外语义（error / ended）。
 */
export type ExecutionStatus = "running" | "closed";

/**
 * closed 终态的 L2 关闭原因子枚举。
 *
 * 与 ExecutionStatus="closed" 配合使用，表达「为什么关闭」：
 *   parent-shutdown  — 父进程 session_shutdown 时回收子进程
 *   parent-fork     — 父进程 fork 新 session 时清理旧子进程
 *   parent-new      — 父进程创建新 subagent 时清理旧子进程
 *   user-close      — 用户手动 close action（含对话模式 close）
 *   cancelled       — 用户取消（close(force:true) / cancelBackground）
 *   gc              — 通用完成/失败（一次执行自然结束、超时、错误等无专属 reason 的终态）
 */
export type ClosedReason = 'parent-shutdown' | 'parent-fork' | 'parent-new' | 'user-close' | 'cancelled' | 'gc';

/**
 * 对外四态（设计决策 10 细则 3）：内部 ExecutionStatus（v4 B-1 两态）收敛为 agent
 * 可理解的状态语义。
 *
 *   running              → active   （正在执行 / 对话模式活跃）
 *   closed + L2 reason   → ended 或 error（按 ClosedReason 派生）
 *     - closedReason=cancelled/parent-shutdown/parent-fork/parent-new/gc/user-close → ended
 *     - （未来扩展：如 closedReason=crash → error）
 *
 * 原始 ExecutionStatus 进 list item 的 status 字段供调试；state 是对外主字段。
 * 未来内部加态（如 paused）只需扩展 mapExternalState，不影响对外契约。
 */
export type ExternalState = "active" | "waiting" | "ended" | "error";

/** 执行模式。background = 调用方立即拿 handle 返回，子 agent 在 detached promise 里跑。 */
export type ExecutionMode = "background";

// ============================================================
// Agent 事件流（Core → Record 的唯一更新驱动）
// ============================================================

/**
 * Pi session.subscribe 上报的事件。Runtime 把它喂给 updateFromEvent。
 *
 * 设计：AgentEvent 携带 updateFromEvent 收口进 record 所需的**全部数据**——
 * tool_end 带 result（供 turn.toolCalls 存完整 ToolCall），无需翻译层旁路累积。
 */
export type AgentEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "tool_end"; toolName: string; args?: unknown; result?: ToolCallResult; isError?: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "turn_end"; summary?: string }
  | { type: "message_end"; usage?: AgentUsage; error?: string }
  | { type: "compaction" }
  | { type: "error"; message: string };

/** token 用量（message_end 时由 Core 累加进 record.totalTokens）。 */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 本 message 的成本（USD，来自 SDK usage.cost.total）。可选——无成本数据时缺省。 */
  cost?: number;
}

export interface AgentUsageTotal extends AgentUsage {
  /** 上述四项之和。投影时不再手工求和。 */
  total: number;
  /** 累计成本（USD，来自 SdkEvent.message.usage.cost.total 求和）。无成本数据时为 0。 */
  cost: number;
}

/**
 * eventLog 条目（getEventLog 派生产出的元素）。所有字段 readonly。
 *
 * text_output / thinking 类型已移除——它们是 100 字切片的碎片副产物，
 * 现在完整内容收口在 record.turns[] 里，eventLog 只承载离散语义事件
 * （tool 调用 / turn 边界 / error）。
 */
export interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "turn_end" | "error";
  readonly label: string;
  /** 事件发生的墙钟时间戳（Date.now()，ms）。由 getEventLog 从 turns[] 派生时记录。 */
  readonly ts: number;
  readonly status?: "running" | "done" | "failed";
}

/**
 * [STEP3] displayItem：从 turns[] 派生的展示项（对齐 nicobailon getDisplayItems）。
 *
 * 与 eventLog 的区别：eventLog 承载离散语义事件（tool_start/tool_end/turn_end），
 * displayItem 承载「可渲染单元」（toolCall 含完整 name+args 供 formatToolCall 格式化；
 * text 含 assistant 正文）。renderResult compact 分支改用 displayItems 后，
 * 行格式与 nicobailon 完全一致（→ formatToolCall）。
 */
export interface DisplayItem {
  readonly type: "toolCall" | "text";
  /** toolCall：tool 名称（bash/read/edit...）；text：无。 */
  readonly name?: string;
  /** toolCall：tool 原始 args（供 formatToolCall 提取路径/命令）；text：无。 */
  readonly args?: Record<string, unknown>;
  /** toolCall：执行状态（running 时无✓/✗标记）；text：正文文本。 */
  readonly status?: "running" | "done" | "failed";
  /** text：assistant 正文（compact 时取首行/截断）。 */
  readonly text?: string;
}

// ============================================================
// Agent 结果（一次执行的 outcome）
// ============================================================

/**
 * SDK AgentSessionEvent 的最小可用子集（duck-typed，避免强耦合 SDK 类型）。
 * 由 session-runner 内部消费，驱动累积器和事件翻译。
 */
export type SdkEvent = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
  message?: {
    usage?: AgentUsage & { cost?: { total: number } };
    stopReason?: string;
    errorMessage?: string;
    /** 消息角色（message_start 事件携带，user/assistant/toolResult/custom）。
     *  MF-5：消费确认制按 user 消息的 message_start 清除 pendingMessages（设计决策 6 spec L251）。 */
    role?: string;
  };
  assistantMessageEvent?: { type?: string; delta?: string };
  reason?: string;
};

/** tool 调用结果（tool_execution_end 时累积，含 structured-output 的 details）。 */
export interface ToolCallResult {
  content?: unknown[];
  details?: unknown;
}

/**
 * tool 调用（导出的纯净数据形状，不含内部状态）。
 *
 *   tool_start 到达但 tool_end 未到时，调用为进行中；一旦 tool_end 到达，
 *   result/isError 填充完成。对外投影（AgentResult.toolCalls / getAllToolCalls）
 *   一律返回此类型——**不泄漏 running/done/failed 内部状态机**。
 *
 * 进行中状态由 execution-record 内部的 `InternalToolCall`（= ToolCall + _status）承载，
 * 只存在于 record.turns[].toolCalls，跨边界导出时由 getAllToolCalls strip _status。
 */
export interface ToolCall {
  toolName: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
}

/**
 * 内部 ToolCall：在 ToolCall 基础上追加 _status 进行中状态标记与 startedTs 时间戳。
 *
 *   running = tool_start 已收到但 tool_end 未到；
 *   done/failed = tool_end 已到。
 *
 * 仅存在于 ExecutionRecord.turns[].toolCalls（Core 内部可变状态）。
 * 跨边界导出（getAllToolCalls → AgentResult.toolCalls / 持久化）由 getAllToolCalls
 * 映射回 ToolCall（丢弃 _status / startedTs），保证导出形状清洁。
 */
export interface InternalToolCall extends ToolCall {
  _status: "running" | "done" | "failed";
  /** tool_start 到达时的墙钟时间戳（Date.now()，ms）。getEventLog 派生 tool 条目 ts 用。 */
  startedTs: number;
}

/**
 * 一个 turn 的完整内容（ExecutionRecord.turns[] 的元素）。
 *
 * 收口设计：text/thinking 流式累积**完整内容**（非 100 字切片），
 * toolCalls 存完整 ToolCall（含 result + _status 内部状态）。turn_end 到达后 closed=true，
 * 下次 text/thinking/tool 时开新 turn。
 *
 * eventLog / currentActivity / result 均从 turns[] 派生，不再独立存储。
 */
export interface Turn {
  /** 本 turn assistant 正文（text_delta 流式累积，完整）。 */
  text: string;
  /** 本 turn 推理（thinking_delta 流式累积，完整）。 */
  thinking: string;
  /** 本 turn 工具调用（InternalToolCall：含完整 result + _status 进行中标记）。 */
  toolCalls: InternalToolCall[];
  /** 本 turn message_end 的 token 增量（聚合得 totalUsage）。 */
  usageDelta?: AgentUsage;
  /** turn_end 是否已到达。false=正在进行；true=已闭合，下次内容开新 turn。 */
  closed: boolean;
  /** turn_end 到达时的墙钟时间戳（Date.now()，ms）。getEventLog 派生 turn_end 条目 ts 用。 */
  closedTs?: number;
}

/** 一次 session 执行的完整结果。collectResult 产出，写入 Record.outcome。 */
export interface AgentResult {
  text: string;
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  toolCalls: ToolCall[];
  usage?: AgentUsageTotal;
  /** /resume /fork 可恢复的 session 文件名（不含目录）。 */
  sessionFile?: string;
  /** schema 模式下，structured-output tool 的 result.details（已通过 schema 校验）。 */
  parsedOutput?: unknown;
}

// ============================================================
// ExecutionRecord —— 唯一状态对象（Core 拥有，Runtime 引用）
// ============================================================

/**
 * 所有执行路径的唯一状态源。
 *
 * 收口设计：一次执行的完整内容（text/thinking/toolCalls/usage）按 turn 收口在
 * `turns: Turn[]` 里。eventLog / currentActivity / result 文本均从 turns[] 派生
 * （getEventLog / getCurrentActivity / getFullText），不再独立存储切片或缓冲。
 *
 * 生命周期：createRecord() 创建 → updateFromEvent() 实时更新（累积进 turns）→
 *           completeRecord() 冻结 → archive 立即移出内存（读时从 session.jsonl 重建）。
 *
 * TUI 永远拿 RecordSnapshot（.slice() 快照），不直接持此可变对象。
 */
/**
 * worktree handle 值对象。仅 worktree:true 时持有——worktree 是独立维度，
 * 需显式开启，fork alone 不创建 worktree。
 * Object.freeze 守卫保证不可变。
 */
export interface WorktreeHandle {
  /** checkout 目录（子 agent 工作目录，tmpdir 下）。 */
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  /** 主仓库根目录（cleanup/scan 需要，不再靠路径反推）。 */
  readonly mainCwd: string;
}

/** alive marker：子进程存活标记，用于心跳检测和 crash 推断。 */
export interface AliveMarker {
  readonly pid: number;
  readonly id: string;
  readonly startedAt: number;
}

/** git diff patch 结果。 */
export interface PatchResult {
  readonly patchFile: string;
  readonly failed: boolean;
  /** patch 是否实际写入 patchFile。true=diff 非空且写盘成功；false=空 diff 或写失败。
   *  调用方据此回填 record.patchFile，避免悬空路径（`git apply` 不存在的文件）。 */
  readonly written: boolean;
}

/** resolveSessionContext 纯函数的入参（#3 SessionContextResolver）。 */
export interface SessionResolveInput {
  fork?: boolean;
  cwd?: string;
  mainCwd: string;
  mainSessionFile?: string;
  parentForkDepth?: number;
  /** agent 配置目录（getSubagentSessionDir 需要）。 */
  agentDir: string;
  /** worktree checkout 路径（来自 WorktreeHandle.path，作为 effectiveCwd）。 */
  worktreePath?: string;
}

/** resolveSessionContext 纯函数的返回值。 */
export interface ResolvedSessionContext {
  readonly shouldFork: boolean;
  readonly forkSource: string | undefined;
  readonly effectiveCwd: string;
  readonly sessionDir: string;
}

/** fork depth 超限错误。 */
export class ForkDepthExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkDepthExceededError";
  }
}

/** worktree 有未提交变更错误。 */
export class DirtyWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirtyWorktreeError";
  }
}

/**
 * 在途消息缓存条目（消费确认制，设计决策 6 状态×interrupt 映射）。
 *
 * busy 投递（follow_up/steer）时缓存进 {@link ExecutionRecord.pendingMessages}；
 * pi 消费确认（message_start/turn_start 事件）时清除；进程死亡时由 M2-B2 补投。
 * M2-B1 只加此类型 + 投递时 push，不做清除/补投（M2-B2 实现）。
 */
export interface PendingMessage {
  /** 消息唯一 id（FIFO 匹配用，crypto.randomUUID 生成）。 */
  readonly id: string;
  /** 消息正文。 */
  readonly text: string;
  /** true=steer（抢占）/ false=follow_up（排队），决策 6 状态×interrupt 映射。 */
  readonly interrupt: boolean;
  /** 投递墙钟时间戳（Date.now()，ms），诊断/超时判断用。 */
  readonly sentAt: number;
}

export interface ExecutionRecord {
  /** 唯一 ID（sync: "run-N"，bg: "bg-N-xxx"）。 */
  readonly id: string;

  // ── 身份（创建时确定，不可变）──
  readonly agent: string;
  readonly model: string;
  readonly thinkingLevel: string | undefined;
  readonly mode: ExecutionMode;
  readonly task: string;
  /**
   * 人类可读的短标签（≤35 字符），简述本次 subagent「在做什么」。
   * 区别于 agent（类型名）/ task（完整 prompt）。旧持久化 record 反序列化时缺失兜底空串。
   */
  readonly slug: string;
  readonly startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。递归链上所有层 record 同值。 */
  readonly rootSessionId: string | undefined;
  /** 直接父 subagent record ID（层级树构建用）。顶层 record 为 undefined。 */
  readonly parentRecordId: string | undefined;
  /** subagent 递归深度。顶层（主 session 直接创建）=0，每层嵌套 +1。 */
  readonly depth: number;
  /**
   * 对话模式标志（可持续对话 subagent）。true = 轮次完成进 idle 态（保留 record +
   * worktree）等待续聊，而非一次性终态化。
   * undefined/false = 一次性模式（默认，行为完全不变）。
   * 向后兼容：旧 record / 旧 session 文件无此字段，按一次性模式处理。
   */
  readonly chatMode?: boolean;
  /**
   * 空闲超时毫秒数（仅 chatMode 有意义）。覆盖默认 5min idle timeout。
   * 优先级：参数 > env PI_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms。
   * 向后兼容：旧 record 无此字段，按默认值处理。
   */
  readonly idleTimeoutMs?: number;

  // ── 状态（实时更新）──
  status: ExecutionStatus;
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。表达「为什么关闭」。
   *  由 tryTransition(record, "closed", reason) 写入；投影层按需派生对外语义。
   *  向后兼容：旧 record 无此字段，按 gc 处理（通用完成/失败）。 */
  closedReason?: ClosedReason;
  /** 完整执行内容，按 turn 组织。createRecord 初始化为 [空 turn]。 */
  turns: Turn[];
  /** turn 计数（= turns.filter(closed).length，冗余存储供投影直接读）。 */
  turnCount: number;
  totalTokens: number;
  /** 运行期最近一次 error 事件的消息（getEventLog 派生 error 条目用）。 */
  lastError: string | undefined;
  /**
   * 对话轮次计数（仅 chatMode 有意义）。首轮运行时 = 0；每完成一轮（finalizeRoundToIdle
   * 进 idle）+1。undefined 时视为 0。非 chatMode 不自增。
   */
  round?: number;
  /**
   * [增量通知] 当前轮次增量的 turns[] 起始下标（仅 chatMode 有意义；内存态记账，D4 不持久化）。
   *
   * - 生命周期：undefined 视为 0（首轮增量 = 全量，与改造前首轮通知逐字节一致，向后兼容旧
   *   record）；唯一写点 onRoundSettled 第 5 步（notify 之后推进），唯一读点同回调第 2 步
   *   （`getFullTextFrom(record, record.roundBaseTurnIndex ?? 0)`）。非 chatMode 恒
   *   undefined（onRoundSettled 是 session-runner chatMode 分支专属回调）。
   * - D1 滞后空 turn 防丢文本（防御性）：pi 当前事件序下该形态不可达——带 usage 的
   *   message_end 恒先于 turn_end（@earendil-works/pi-agent-core dist/agent-loop.js
   *   :240/:253/:547 三处 message_end emit 均在 :131 正常路径 turn_end 之前），settle 时
   *   turn 全闭合。防 pi 未来事件序变化：若 settle 时刻末 turn 是滞后 message_end 开出的
   *   空 turn（execution-record.ts message_end 分支经 currentTurn，需同时过两层 usage 守卫：
   *   session-runner.ts 转发层 `if (msg?.usage)`（bare message_end 不转发）+ execution-record.ts
   *   累积层 `if (event.usage)`（bare message_end 不开 turn）），推进公式
   *   nextRoundBaseTurnIndex 把它留在下一轮增量内（新轮首个 text_delta 经 currentTurn 复用该
   *   空 turn，复用累积被 slice 覆盖）；直用 turns.length 推进会把下轮首段文本挤出 slice
   *   范围静默丢失。
   * - D4 不持久化：磁盘重建走 createRecord（turns 仅为初始 [emptyTurn()]），base=0 对空 turn
   *   的增量派生等价为空、天然产出仅新轮增量，持久化是死数据。故不写 manifest、不参与重建。
   * - pi 内部序锚定依据（R1 mitigation）：@earendil-works/pi-agent-core 0.84.0
   *   dist/agent-loop.js :106-113（error/aborted stopReason 也先 emit turn_end 再 agent_end）
   *   与 :131（正常路径 turn_end 收尾）；agent_settled 在 agent_end 之后 emit，故未闭合
   *   turn 只可能来自滞后事件。pi 升级若改变 turn_end/agent_end 时序，onRoundSettled 推进前
   *   的观测哨（末 turn 未闭合且 text 非空 → logger.warn）会留痕。
   */
  roundBaseTurnIndex?: number;
  /**
   * record 进入 idle 态的时间戳（ms）。finalizeRoundToIdle 设值；GC 定时器据此计算
   * 剩余 TTL。undefined = 非 idle 态（running/closed/cancelled）或旧 record 缺失字段。
   */
  idleSince?: number;
  /**
   * 在途消息缓存（消费确认制，设计决策 6）。busy 投递（follow_up/steer）时缓存；
   * pi 消费确认（message_start/turn_start，M2-B2 实现）时清除；进程死亡时 M2-B2 补投。
   * M2-B1 只加字段 + 投递时 push，不做清除/补投。undefined/空 = 无在途消息。
   */
  pendingMessages?: PendingMessage[];
  /**
   * close 优雅关闭标志（M2-B3）。chatMode record 运行中调 `close {force:false}` 时置 true；
   * runAndFinalize 的 done 分流检查此标志——true 则终态化为 done（而非进 idle），并清标志。
   * undefined/false = 正常 idle 分流（对话模式轮次完成进 idle 等续聊）。
   * 仅 chatMode + running 时有意义；force:true（立即终止）不走此标志。
   */
  closeAfterRound?: boolean;

  // ── 完成 ──
  endedAt: number | undefined;
  result: string | undefined;
  error: string | undefined;
  /** 完整 AgentResult（含 usage/toolCalls，完成时填）。 */
  agentResult: AgentResult | undefined;

  /** session jsonl 文件名。session 创建成功后由 session-runner.run() 回填（窗口期内 undefined）。 */
  sessionFile?: string;

  /**
   * [V2 决策 3] 子进程 pid（spawn 后由 session-runner 回填到内存 record）。
   *
   * 用于 lifecycle-manager 孤儿扫描（V2 §5.2 职责 4：父进程重启时按持久化 pid 扫收
   * 上次崩溃遗留的孤儿）。本字段仅在内存记账，持久化留 Step 5（record
   * 文件写入 pid + 启动时 scanOrphanProcesses 消费）。undefined = 尚未 spawn / 已退出。
   * 向后兼容：旧 record 无此字段，按无 pid 处理（孤儿扫描跳过）。
   */
  pid?: number;

  /** [MF#3] worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
  patchFile?: string;

  /** worktree 隔离时的 handle（仅 worktree:true 时存在；fork alone 无此字段）。 */
  worktreeHandle?: WorktreeHandle;

  // ── 控制（仅 background 持有）──
  controller: AbortController | undefined;
}

// ============================================================
// Runtime → TUI 的投影契约
// ============================================================

/**
 * Tool 返回的 details（内层扁平结构）。
 * 由 project(record) 唯一产出——sync/bg 两路径字段一致。
 * 含 mode + sessionFile（供外层 SubagentToolResult 分组 + spinner 判断）。
 *
 * 分层（spec FR-3）：此为**内层**，不感知 action/外层分组。
 * 外层 SubagentToolResult 由 adapter 包裹产出（加 action/subagentId/sessionFile + 分组）。
 */
export interface SubagentToolDetails {
  status: ExecutionStatus;
  mode: ExecutionMode;
  agent: string;
  model: string;
  thinkingLevel: string | undefined;
  /** 短标签（≤35 字符），来自 record.slug。旧 record 反序列化时为空串。 */
  slug: string;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  eventLog: AgentEventLogEntry[];
  /** [STEP3] 从 turns[] 派生的展示项（对齐 nicobailon getDisplayItems）。 */
  displayItems: DisplayItem[];
  result?: string;
  error?: string;
  /** running 时的当前活动行（tool/thinking/text 优先级）。 */
  currentActivity?: { type: "tool" | "text" | "thinking"; label: string };
  /** schema 模式下，structured-output tool 的 result.details（对齐 workflow agent-pool）。 */
  parsedOutput?: unknown;
  /** session jsonl 文件名（不含目录）。窗口期内可能 undefined（session 尚未创建成功）。 */
  sessionFile?: string;
  /** [MF#3] worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
  patchFile?: string;
}

// ============================================================
// Runtime 公共 API 的入参/出参
// ============================================================

/** Hub.execute 的入参（sync/bg 共用）。mode 由 Hub 内部判定，不暴露给调用方。 */
export interface ExecuteOptions {
  task: string;
  /**
   * 短标签（≤35 字符），简述本次执行用途，展示在 TUI。必填。
   * workflow 内 agent() 调用时从 AgentCallOpts.description 透传而来。
   */
  slug: string;
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  /** D-A6 bridge: workflow schemaEnv 经 ExecuteOptions 透传到 runSpawn childEnv。 */
  schemaEnv?: string;
  maxTurns?: number;
  graceTurns?: number;
  /** sync 模式来自 Pi tool 框架；background 模式 hub 忽略，自建 controller。 */
  signal?: AbortSignal;
  /** 主 agent 当前模型（模型解析第三层兼底）。execute 调用方从 ctx.model 传入。 */
  ctxModel?: ModelInfo;
  /** live 状态回流（对话流 block 实时刷新）。 */
  onUpdate?: (details: SubagentToolDetails) => void;
  /** background 完成回调（sync 不调）。 */
  onComplete?: (record: RecordSnapshot) => void;
  /** 是否继承父会话上下文（fork 模式，只继承上下文）。 */
  fork?: boolean;
  /** 文件系统隔离：true=创建新 git worktree，WorktreeHandle=复用外部已创建的；undefined=不隔离（parent cwd）。 */
  worktree?: boolean | WorktreeHandle;
  /** 覆盖执行 cwd（默认 mainCwd）。 */
  cwd?: string;
  /**
   * 可持续对话模式（决策 8：独立 chatMode 标志，不扩展 ExecutionMode）。
   * true = record 标记 chatMode，轮次完成进 idle 态（保留 record + worktree，等待 message 续聊）；
   * undefined/false = 一次性模式（默认，行为完全不变）。service.execute 透传到 createRecordForMode。
   */
  conversation?: boolean;
  /**
   * 空闲超时毫秒数（仅 conversation 模式有意义）。覆盖默认 5min idle timeout。
   * 优先级：参数 > env PI_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms。
   */
  idleTimeoutMs?: number;
  // 注：fork 深度不从外部传入（曾暴露 parentForkDepth，改用 ALS 后 execute 内部从调用链派生，
  // 公开字段成为死字段误导调用方，已移除）。深度限制检查见 session-runner.ts 内部 RunOptions.parentForkDepth
  // （与历史残留的 types.ts RunOptions 同名不同 interface——后者已删除）。
}

/**
 * execute 返回值。
 *   background: { mode:"background", subagentId, sessionFile, details } —— 立即返回。
 *            subagentId 供后续 cancel/list 用；sessionFile 窗口期可能 undefined。
 */
export type ExecutionHandle = {
  mode: "background";
  subagentId: string;
  sessionFile: string | undefined;
  details: SubagentToolDetails;
};

// ============================================================
// tool action 出参（外层分组，adapter 产出）
// ============================================================

/** list 的 item 结构。 */
export interface SubagentListItem {
  subagentId: string;
  agent: string;
  /** 短标签（≤35 字符），来自 record.slug。旧 record 反序列化时为空串。 */
  slug: string;
  /** 对外四态（决策 10 细则 3，主字段）。由 mapExternalState(status) 派生。 */
  state: ExternalState;
  /** 原始内部状态（调试用，供 details 展示）。 */
  status: ExecutionStatus;
  mode: ExecutionMode;
  /** 运行秒数（running 态实时计算，终态 endedAt-startedAt）。 */
  duration: number;
  model: string;
  totalTokens: number;
  /** session jsonl 文件名（窗口期内可能 undefined）。 */
  sessionFile?: string;
  /** 直接父 subagent record ID（顶层 record 为 undefined）。[v4 A-6] 从
   *  record.parentRecordId 派生，配合 A-5 直接父守卫（message/close 仅作用于直接子）。 */
  parent?: string;
  /** 可冷路径 resume（running 且无活进程句柄）。[v4 A-6] B-1「可续聊」对外表达，
   *  agent 据 list 判断哪些 running subagent 实际可续聊（vs 正在忙）。 */
  resumable?: boolean;
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。[v4 A-6] SP-4 级联关闭告知
   *  替代——砍 before_agent_start 注入通道后，被级联关闭的 record 经 list
   *  （includeFinished:true）可查，closedReason 显示 'parent-fork'/'parent-new' 等。 */
  closedReason?: ClosedReason;
}

/** background 启动的内层响应（挂在 SubagentToolResult.bgResponse）。 */
export interface BgResponse {
  status: "running";
  mode: "background";
  /** 启动提示文案（"detached, will notify on completion"）。 */
  message: string;
}

/** list 的内层响应（挂在 SubagentToolResult.listResponse）。 */
export interface ListResponse {
  /** items 中 status==="running" 的计数（受 limit 截断如实反映，非全局总数）。 */
  running: number;
  items: SubagentListItem[];
}

/** cancel 的内层响应（挂在 SubagentToolResult.cancelResponse）。 */
export interface CancelResponse {
  cancelled: true;
}

/** message 的内层响应（挂在 SubagentToolResult.messageResponse，决策 10 瘦身）。 */
export interface MessageResponse {
  delivered: true;
}

/** close 的内层响应（挂在 SubagentToolResult.closeResponse，决策 10 瘦身）。 */
export interface CloseResponse {
  closed: true;
}

/**
 * Tool 外层出参（renderResult + LLM content JSON 同源）。
 * adapter 唯一产出：领域对象（bg/list/cancel 三选一）+ action/subagentId/sessionFile。
 *
 *   - background 启动 → bgResponse（subagentId 有值；sessionFile 窗口期可能 undefined）
 *   - list → listResponse（最外层 subagentId/sessionFile 为 null，sessionFile 在各 item 内）
 *   - cancel → cancelResponse（subagentId 有值；sessionFile 无意义，可为 null）
 */
export type SubagentToolResult =
  | { action: "start"; subagentId: string; sessionFile: string | null; slug: string; bgResponse: BgResponse; __gui__?: GuiRenderResult }
  | { action: "list"; subagentId: null; sessionFile: null; listResponse: ListResponse; __gui__?: GuiRenderResult }
  | { action: "cancel"; subagentId: string; sessionFile: null; cancelResponse: CancelResponse; __gui__?: GuiRenderResult }
  | { action: "message"; subagentId: string; sessionFile: null; messageResponse: MessageResponse; __gui__?: GuiRenderResult }
  | { action: "close"; subagentId: string; sessionFile: null; closeResponse: CloseResponse; __gui__?: GuiRenderResult };

// ============================================================
// TUI list 视图的合并 record（4 源 merge 后的形状）
// ============================================================

/** /subagents list 左列展示单元。来自内存(running) 或 session.jsonl 重建(终态)。 */
export interface SubagentRecord {
  id: string;
  agent: string;
  /** 任务提示词（详情面板置顶展示）。磁盘/内存源均有。 */
  task: string;
  /** 短标签（≤35 字符）。磁盘重建源旧文件可能缺失→兜底空串。 */
  slug: string;
  status: ExecutionStatus;
  /** L2 关闭原因子枚举（仅 status="closed" 时有意义）。SP-1 新增。 */
  closedReason?: ClosedReason;
  mode: ExecutionMode;
  startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。递归链上所有层 record 同值。 */
  rootSessionId: string | undefined;
  /** 直接父 subagent record ID（层级树构建用）。顶层 record 为 undefined。 */
  parentRecordId: string | undefined;
  /** subagent 递归深度。顶层 =0，每层嵌套 +1。 */
  depth: number;
  endedAt: number | undefined;
  turns: number;
  totalTokens: number;
  model: string;
  thinkingLevel: string | undefined;
  eventLog: AgentEventLogEntry[];
  /** [STEP3] 从 turns[] 派生的展示项（对齐 nicobailon getDisplayItems）。 */
  displayItems: DisplayItem[];
  /** running 时的当前活动行（仅内存源；磁盘重建无此数据）。streaming 可观测性用。 */
  currentActivity?: { type: "tool" | "text" | "thinking"; label: string };
  result?: string;
  error?: string;
  sessionFile?: string;
  /** [MF#3] worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
  patchFile?: string;
  /**
   * 对话轮次计数（仅 chatMode idle record 有意义）。round 仅在内存维护（doFinalizeRoundToIdle
   * 递增），跨重启不恢复（round 无磁盘持久化）；非对话模式 / 非 idle record 为 undefined。内存源由 recordToSubagent 从
   * ExecutionRecord.round 投影。
   */
  round?: number;
  /** 外部 Pi 实例（进程隔离模式下由外部启动的子进程）。 */
  externalInstance?: AliveMarker;
  /** fork 模式下的 worktree handle。 */
  worktreeHandle?: WorktreeHandle;
}

// ============================================================
// 配置（global + session）
// ============================================================

/**
 * 全局配置（~/.pi/agent/subagents/config.json）。
 *
 * 模型解析已退化为「主 agent model 优先，仅 override 时查 registry」——
 * 不再有 category/fallback/yolo 字段。config.json 只保留 maxConcurrent
 * （pool 大小）。旧 config.json 中的 categories/fallback 等字段读取时忽略。
 */
export interface SubagentsGlobalConfig {
  version: number;
  maxConcurrent: number;
}

// ============================================================
// 只读快照（TUI 消费，永不 mutate）
// ============================================================

/**
 * Record 的只读视图。store.snapshot() 返回。
 * TUI 拿到此类型，保证不会回写 Core 状态。
 *
 * 不含 eventLog——snapshot 的消费点（cancel 判 mode/status、hasRunning 判 mode、
 * toNotifyRecord 取 result/error）均不读 eventLog。需要 eventLog 的场景用 project()
 * 投影的 SubagentToolDetails。需要完整内容用 record.turns[]（Core 内部）。
 */
export interface RecordSnapshot {
  readonly id: string;
  readonly agent: string;
  readonly model: string;
  readonly thinkingLevel: string | undefined;
  readonly mode: ExecutionMode;
  readonly task: string;
  /** 短标签（≤35 字符）。来自 record.slug。 */
  readonly slug: string;
  readonly status: ExecutionStatus;
  /** 对话模式标志（与 ExecutionRecord.chatMode 同源）。cancel 别名判定用。 */
  readonly chatMode?: boolean;
  readonly turns: number;
  readonly totalTokens: number;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly result: string | undefined;
  readonly error: string | undefined;
  readonly sessionFile: string | undefined;
}

// Re-export 用于 ExecuteOptions 的 agent/model 契约
// ============================================================
// SDK duck-typed 接口（测试可 mock，session-runner 消费）
// ============================================================

/** AgentSession 的最小可用接口（duck-typed，与 SDK AgentSession 结构兼容）。 */
export interface AgentSessionLike {
  prompt(task: string, options?: unknown): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(fn: (event: unknown) => void): () => void;
  sessionId: string;
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
    /** 写 custom entry（subagent-identity 持久化用）。SDK SessionManager.appendCustomEntry 的 duck-type。 */
    appendCustomEntry(customType: string, data?: unknown): string;
  };
  messages: ReadonlyArray<{
    role: string;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }>;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
}

/** DefaultResourceLoader 的最小可用接口（duck-typed）。 */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/** createAgentSession 入参的类型化子集（对应 SDK CreateAgentSessionOptions）。 */
export interface CreateAgentSessionArgs {
  model: unknown;
  thinkingLevel?: string;
  cwd: string;
  resourceLoader: ResourceLoaderLike;
  modelRegistry: ModelRegistryLike;
  sessionManager: unknown;
}

/** DefaultResourceLoader 构造参数的类型化子集。 */
export interface ResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  appendSystemPrompt: string[];
  additionalSkillPaths?: string[];
}

/** SessionManager 实例的最小接口（duck-typed，fork 路径消费 SDK 静态方法的返回值）。 */
export interface SessionManagerLike {
  getLeafId(): string | null;
  createBranchedSession(leafId: string): string | undefined;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

/** Pi SDK 动态 import 的形状（getSdk() 获取）。 */
export interface SdkLike {
  DefaultResourceLoader: new (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  SessionManager: {
    inMemory(cwd?: string): SessionManagerLike;
    create(cwd: string, sessionDir?: string): SessionManagerLike;
    open(sessionFile: string, sessionDir?: string, cwdOverride?: string): SessionManagerLike;
    /** [MF#1] fork 静态方法：从源 session 文件 fork 到目标 cwd，返回 SessionManager。 */
    forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManagerLike;
  };
  createAgentSession: (opts: CreateAgentSessionArgs) => Promise<{ session: AgentSessionLike }>;
}
