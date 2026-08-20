/**
 * applyEntry —— chat 视图态 reducer（data-source-governance W20，D5「单一 reducer 双路喂入」重放侧）。
 *
 * 职责：把 pi session entry（get_entries 返回 / 实时事件重构，W21）逐条投影为 chat 视图态切片。
 * 消息列表 = entry 日志的纯函数——同 entry 序列必得同 state，「live ≡ reload」从构造上成立。
 *
 * 纯度契约（验收权威 w20-acceptance.md 规格锁定 1）：
 * - 无副作用、无时序依赖：不读 Date.now / crypto.randomUUID / Math.random，
 *   消息 id 与缺失 timestamp 全部从 entry 派生（确定性），两次喂入同一序列 state 全等。
 * - 不 mutate 输入 state / entry：toolResult 回填等就地变更点全部 copy-on-write。
 * - console.warn 是可观测性（未知 role / 孤儿 toolResult），不影响确定性——与迁移前行为对齐。
 *
 * 规则迁移源：packages/runtime/src/infra/pi/message-converter.ts 重放路径
 * （convertSinglePiMessage 的 content parts 解析 / skill block 剖离 / usage / fileChanges 静态提取、
 * convertPiHistory 的 toolResult 窗口局部配对 / compactionSummary / custom / branchSummary /
 * bashExecution 分支）。runtime 保留 wire 层职责（RPC reply → entry 列表 → 喂本 reducer，
 * 见 message-converter.ts liftHistoryToEntries），派生规则唯一实现在此（D7 投影一次）。
 *
 * [已知分叉，收敛待后续 wave] stripAnsi/normalizePiToolResult 与 runtime
 * infra/pi/normalize-tool-result.ts（event-adapter 实时路径 hook 上下文消费）仍为两份：
 * core 不依赖 runtime（包依赖方向）。W21 起 core 版已导出（effects/registry 的
 * tool_call_end overlay 收口消费，输入语义 = toolResult message body），shared 收敛
 * 留待后续 wave 统一处理。W5（2026-08-20）images 提取差异已消除——两份行为对齐
 * （此前 core 副本丢 toolResult content 的 ImageContent → 图片工具结果重开消失，
 * 破 live≡replay；审计 #3，pi-assumption-remediation）。
 *
 * 本模块群自包含约束（runtime tsup 打包 / renderer vite 消费双重入口）：本模块群
 * （apply-entry.ts + apply-entry-convert.ts + apply-entry-utils.ts）只 import
 * '@xyz-agent/shared' 与群内文件，不 import core 内群外模块（防 vue 依赖渗入 runtime bundle）。
 * 拆分布局（依赖单向 convert → utils、本文件 → utils + convert，禁止循环 import）：
 * - apply-entry-utils.ts：共享底层（normalizePiToolResult / toMs / Record 守卫 / 常量类型）
 * - apply-entry-convert.ts：message body 转换群（convertMessageBody / computeToolCallFill 等）
 * - 本文件：reducer 本体（apply* handler / applyEntry / replayEntries）+ 对外导出面。
 */
import type {
  Message,
  PiBranchSummaryEntry,
  PiCompactionEntry,
  PiCustomEntry,
  PiCustomMessageEntry,
  PiEntry,
  PiEntryBase,
  PiMessageBody,
  PiMessageEntry,
  ToolCall,
} from '@xyz-agent/shared'
import { COMPLETE_NOTIFY_CUSTOM_TYPES } from '@xyz-agent/shared'
import { computeToolCallFill, convertMessageBody } from './apply-entry-convert'
import { CLIENT_MSG_ID_TYPE, isLooseRecord, isPlainRecord, toMs } from './apply-entry-utils'
import type { PiToolResultBody } from './apply-entry-utils'

// ── pi entry 类型（W21 下沉 shared/pi-entry.ts，此处 re-export 保持 core API 兼容）───────
//
// 下沉动机：entry 形态成为三方共用 wire 契约（runtime event-adapter 实时重构 /
// protocol.ts message.* payload 类型 / 本 reducer 输入），shared 是唯一不破坏包依赖
// 方向的归属地。类型定义与注释见 @xyz-agent/shared/pi-entry.ts。
//
// 与 runtime infra/pi/pi-protocol.ts 的 PiSessionEntry 结构兼容（TS 结构类型，runtime 侧
// 无需 import 本文件类型即可喂入）。pi 还有 thinking_level_change / model_change /
// session_info 三个 entry 类型，xyz-agent 未建模——reducer 对未建模 type 走 default no-op
// （不丢弃 entry 语义 = 不崩溃不吞整个重放，见 default 分支注释）。
//
// id 可选的原因：pi 真实 entry 恒有 id（uuidv7）；wire 层 lift 无真实 entry id 的伪消息
// （get_messages 扁平列表 / __entryId 缺失）与实时路径 message_end 重构（pi 在 emit 之后才
// appendMessage 分配 id）均为 undefined——此时 piEntryId 不回填（对齐迁移前 convertPiHistory
// 的 entryIds?.[i] ?? __entryId 解析语义），reducer 按 `e<N>` 确定性派生。
export type {
  PiEntry,
  PiEntryBase,
  PiMessageEntry,
  PiMessageBody,
  PiCustomEntry,
  PiLabelEntry,
  PiCompactionEntry,
  PiBranchSummaryEntry,
  PiCustomMessageEntry,
} from '@xyz-agent/shared'

// normalizePiToolResult / NormalizedToolResult 实体在 apply-entry-utils.ts（convert 侧
// computeToolCallFill 同源调用，依赖单向 convert → utils——实体放本文件会成环），此处
// re-export 维持既有 core API 不变（effects/registry 等继续从本模块 import，见文件头分叉注释）。
export { normalizePiToolResult } from './apply-entry-utils'
export type { NormalizedToolResult } from './apply-entry-utils'

// ── chat 视图态切片 ─────────────────────────────────────────────────

/**
 * reducer 的 state：chat 视图态切片（plan W20 步骤 1）。
 *
 * W20 重放侧从 entry 日志可推导的字段集：messages + clientUuidMap + orphanToolResults。
 * queueDepth / subagents 等 runtime 实时态不可从 entry 重放推导（W21+ 实时喂入侧扩展），
 * 按「不加推测性功能」原则不预置空字段。
 */
export interface ChatViewState {
  /** 重建出的消息列表（entry 日志的投影，按 apply 顺序追加） */
  messages: Message[]
  /** userEntryId → clientUuid（"xyz.client-msg-id" custom entry 累积，badge 回填查表用） */
  clientUuidMap: Map<string, string>
  /** 窗口内无法配对的孤儿 toolResult（增量合并阶段按 toolCallId 回填，W20 review Fix-1 语义） */
  orphanToolResults: PiToolResultBody[]
  /**
   * reducer 簿记：最近一条带 toolCalls 的消息在 messages 中的下标（-1 = 无）。
   * toolResult 窗口局部配对的查找锚点（迁移前 convertPiHistory 同名局部变量语义）。
   */
  lastAssistantWithToolCalls: number
}

/** 初始 state（重放起点）。 */
export function createInitialChatViewState(): ChatViewState {
  return {
    messages: [],
    clientUuidMap: new Map(),
    orphanToolResults: [],
    lastAssistantWithToolCalls: -1,
  }
}

// ── 确定性派生工具（toMs / Record 守卫在 apply-entry-utils.ts）────────────────

/**
 * 本条 entry 派生 Message 的确定性 id 基。
 * entry.id 缺失（lift 的无 id 伪消息）时用「即将追加的消息下标」——同一序列内确定性且唯一
 * （真实 entry.id 是 uuidv7，与 'e<N>' 命名空间无碰撞）。
 */
function deriveBaseId(entry: PiEntryBase, state: ChatViewState): string {
  return entry.id ?? `e${state.messages.length}`
}

// ── reducer 本体 ────────────────────────────────────────────────────

/** toolResult role：窗口局部配对回填 host toolCall，配不上 → 孤儿收集。 */
function applyToolResultMessage(state: ChatViewState, body: PiMessageBody): ChatViewState {
  // 窗口局部配对：只查最近一条带 toolCalls 的消息（迁移前 lastAssistantWithToolCalls 语义）
  const last = state.lastAssistantWithToolCalls
  const host = last >= 0 ? state.messages[last] : undefined
  const tcs = host?.toolCalls
  const matched = tcs?.find((t) => t.id === body.toolCallId)
  if (host !== undefined && tcs !== undefined && matched !== undefined) {
    const fill = computeToolCallFill(body)
    const filled: ToolCall = {
      ...matched,
      output: fill.output,
      ...(fill.outputRaw !== undefined && { outputRaw: fill.outputRaw }),
      ...(fill.isError && { status: 'error' as const }),
      ...(fill.details !== undefined && { details: fill.details }),
      // [W5] images 保字段：shared.ToolCall 暂无 images 类型声明（W5 边界未动
      // shared），spread 条件属性保运行时字段——数据不丢优先（live≡replay），
      // 类型声明与渲染消费待后续 wave shared 加字段后收口。
      ...(fill.images !== undefined && { images: fill.images }),
    }
    const updatedHost: Message = { ...host, toolCalls: tcs.map((t) => (t === matched ? filled : t)) }
    const messages = state.messages.map((m, idx) => (idx === last ? updatedHost : m))
    return { ...state, messages }
  }
  // 孤儿：窗口内无 preceding assistant 或 toolCallId 无匹配——收集给增量合并阶段回填
  const orphan: PiToolResultBody = { ...body, role: 'toolResult' }
  console.warn(`[apply-entry] toolResult has no matching toolCall in window: ${String(body.toolCallId)}`)
  return { ...state, orphanToolResults: [...state.orphanToolResults, orphan] }
}

/** bashExecution role：bash 是元信息非用户输入（W3 WC5）→ 带 bashExecution 字段的 system 消息。 */
function applyBashExecutionMessage(
  state: ChatViewState,
  body: PiMessageBody,
  baseId: string,
  fallbackTs: number,
): ChatViewState {
  // exitCode undefined → null（防 JSON 丢值，与 dispatcher 广播对称）。
  const ts = body.timestamp ?? fallbackTs
  const msg: Message = {
    id: baseId,
    role: 'system',
    content: '',
    status: 'complete',
    timestamp: ts,
    bashExecution: {
      command: typeof body.command === 'string' ? body.command : '',
      output: typeof body.output === 'string' ? body.output : '',
      exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
      cancelled: body.cancelled === true,
      truncated: body.truncated === true,
      excludeFromContext: body.excludeFromContext === true,
      timestamp: ts,
      ...(typeof body.fullOutputPath === 'string' && { fullOutputPath: body.fullOutputPath }),
    },
  }
  return { ...state, messages: [...state.messages, msg] }
}

/** compactionSummary role → system 消息 + compactionSummary 字段。 */
function applyCompactionSummaryMessage(
  state: ChatViewState,
  body: PiMessageBody,
  baseId: string,
  fallbackTs: number,
): ChatViewState {
  const ts = body.timestamp ?? fallbackTs
  const summary = typeof body.summary === 'string' ? body.summary : undefined
  const tokensBefore = typeof body.tokensBefore === 'number' ? body.tokensBefore : undefined
  const msg: Message = {
    id: baseId,
    role: 'system',
    content: summary ?? '上下文已压缩',
    status: 'complete',
    compactionSummary: { summary, tokensBefore, timestamp: ts },
    timestamp: ts,
  }
  return { ...state, messages: [...state.messages, msg] }
}

/**
 * custom role（pi CustomMessage，扩展经 sendMessage 注入）。details 原始透传
 * （__gui__ 等由前端消费）；display 透传（不覆写——见 applyMessageEntry 形态差异注释）。
 */
function applyCustomRoleMessage(
  state: ChatViewState,
  body: PiMessageBody,
  baseId: string,
  fallbackTs: number,
): ChatViewState {
  const ts = body.timestamp ?? fallbackTs
  const msg: Message = {
    id: baseId,
    role: 'system',
    content: typeof body.content === 'string' ? body.content : '',
    status: 'complete',
    customType: typeof body.customType === 'string' ? body.customType : '',
    details: isLooseRecord(body.details) ? body.details : undefined,
    timestamp: ts,
    display: body.display === true || body.display === false ? body.display : undefined,
  }
  return { ...state, messages: [...state.messages, msg] }
}

/** branchSummary role → system 消息 + branchSummary 字段。 */
function applyBranchSummaryRoleMessage(
  state: ChatViewState,
  body: PiMessageBody,
  baseId: string,
  fallbackTs: number,
): ChatViewState {
  const ts = body.timestamp ?? fallbackTs
  const rawSummary = typeof body.summary === 'string' ? body.summary : undefined
  const msg: Message = {
    id: baseId,
    role: 'system',
    content: rawSummary ?? '',
    status: 'complete',
    branchSummary: {
      summary: rawSummary,
      fromId: typeof body.fromId === 'string' ? body.fromId : undefined,
      timestamp: ts,
    },
    timestamp: ts,
  }
  return { ...state, messages: [...state.messages, msg] }
}

/** user/assistant role → convertMessageBody 转换 + lastAssistantWithToolCalls 簿记更新。 */
function applyUserAssistantMessage(
  state: ChatViewState,
  body: PiMessageBody,
  entryId: string | undefined,
  baseId: string,
  fallbackTs: number,
): ChatViewState {
  const msg = convertMessageBody(body, entryId, baseId, fallbackTs)
  if (!msg) return state
  const messages = [...state.messages, msg]
  const next: ChatViewState = { ...state, messages }
  if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
    next.lastAssistantWithToolCalls = messages.length - 1
  }
  return next
}

/**
 * message entry 的 role 细分分派。
 *
 * pi AgentMessage 联合镜像：user/assistant/toolResult/bashExecution/compactionSummary/
 * custom/branchSummary。后三个特殊 role 与专用 entry 类型（compaction/branch_summary/
 * custom_message）双形态存储（session-manager 持久化为 message entry / 专用 entry 均存在；
 * get_messages / mapSessionEntries 的 message-entry 透传路径会以本形态到达）。
 * 语义与专用 entry case 的差异只有一点：display 覆写归专用 custom_message entry case
 * （mapSessionEntries SSOT 同规则），message-role 形态到达时上游已完成或不适用覆写——
 * 迁移前 convertPiHistory 同行为。
 */
function applyMessageEntry(state: ChatViewState, entry: PiMessageEntry): ChatViewState {
  const body = entry.message
  const entryId = entry.id
  const baseId = deriveBaseId(entry, state)
  const fallbackTs = toMs(entry.timestamp)
  switch (body.role) {
    case 'toolResult':
      return applyToolResultMessage(state, body)
    case 'bashExecution':
      return applyBashExecutionMessage(state, body, baseId, fallbackTs)
    case 'compactionSummary':
      return applyCompactionSummaryMessage(state, body, baseId, fallbackTs)
    case 'custom':
      return applyCustomRoleMessage(state, body, baseId, fallbackTs)
    case 'branchSummary':
      return applyBranchSummaryRoleMessage(state, body, baseId, fallbackTs)
    case 'user':
    case 'assistant':
      return applyUserAssistantMessage(state, body, entryId, baseId, fallbackTs)
    default: {
      // 显式拒绝未知 role（W11 语义）：非已建模 role 不默认归 assistant，防数据异常被掩盖
      console.warn(`[apply-entry] unknown role: ${String(body.role)}, skipping`)
      return state
    }
  }
}

/** compaction entry：pi 压缩记录 → system 消息 + compactionSummary 字段（SystemNotice「上下文已压缩」）。 */
function applyCompactionEntry(state: ChatViewState, entry: PiCompactionEntry): ChatViewState {
  const ts = toMs(entry.timestamp)
  const summary = typeof entry.summary === 'string' ? entry.summary : undefined
  const tokensBefore = typeof entry.tokensBefore === 'number' ? entry.tokensBefore : undefined
  const msg: Message = {
    id: deriveBaseId(entry, state),
    role: 'system',
    content: summary ?? '上下文已压缩',
    status: 'complete',
    compactionSummary: {
      summary,
      tokensBefore,
      timestamp: ts,
    },
    timestamp: ts,
  }
  return { ...state, messages: [...state.messages, msg] }
}

/** branch_summary entry：summary 原值透传（'' 保留 ''，缺失 → undefined），content 缺失 fallback 空字符串。 */
function applyBranchSummaryEntry(state: ChatViewState, entry: PiBranchSummaryEntry): ChatViewState {
  const ts = toMs(entry.timestamp)
  const rawSummary = typeof entry.summary === 'string' ? entry.summary : undefined
  const msg: Message = {
    id: deriveBaseId(entry, state),
    role: 'system',
    content: rawSummary ?? '',
    status: 'complete',
    branchSummary: {
      summary: rawSummary,
      fromId: entry.fromId,
      timestamp: ts,
    },
    timestamp: ts,
  }
  return { ...state, messages: [...state.messages, msg] }
}

/**
 * custom_message entry：扩展经 sendMessage 注入的结构化通知 → system 消息（details 原始
 * 透传，__gui__ 前端消费）。完成通知类 customType display 覆写 false（pi 可能持久化 true，
 * xyz-agent 统一隐藏——与 mapSessionEntries 引用同一 SSOT，覆写幂等）。
 */
function applyCustomMessageEntry(state: ChatViewState, entry: PiCustomMessageEntry): ChatViewState {
  const ts = toMs(entry.timestamp)
  const isCompleteNotify = COMPLETE_NOTIFY_CUSTOM_TYPES.has(entry.customType)
  const display = entry.display === true || entry.display === false ? entry.display : undefined
  const msg: Message = {
    id: deriveBaseId(entry, state),
    role: 'system',
    content: typeof entry.content === 'string' ? entry.content : '',
    status: 'complete',
    customType: entry.customType,
    details: isLooseRecord(entry.details) ? entry.details : undefined,
    timestamp: ts,
    display: isCompleteNotify ? false : display,
  }
  return { ...state, messages: [...state.messages, msg] }
}

/**
 * custom entry：纯数据 entry 不进对话流。xyz.client-msg-id 累积 clientUuidMap（badge
 * 回填查表）。data 形状不匹配（缺字段/类型错）→ 跳过（降级不崩溃）；冲突 later-wins
 * （warn 防御）。
 */
function applyClientMsgIdEntry(state: ChatViewState, entry: PiCustomEntry): ChatViewState {
  if (entry.customType !== CLIENT_MSG_ID_TYPE) return state
  const data = entry.data
  if (!isPlainRecord(data) || typeof data.clientUuid !== 'string' || typeof data.userEntryId !== 'string') {
    return state
  }
  const existing = state.clientUuidMap.get(data.userEntryId)
  if (existing !== undefined && existing !== data.clientUuid) {
    console.warn(
      `[apply-entry] clientUuidMap conflict for userEntryId=${data.userEntryId}: ` +
        `existing=${existing}, new=${data.clientUuid} (later wins)`,
    )
  }
  const clientUuidMap = new Map(state.clientUuidMap)
  clientUuidMap.set(data.userEntryId, data.clientUuid)
  return { ...state, clientUuidMap }
}

/**
 * 单条 pi entry → chat 视图态切片的纯函数投影（D5）。
 *
 * 分发骨架：按 entry type 分派到私有 handler（message 经 applyMessageEntry 按 role 细分），
 * 对外契约不变——applyEntry 仍是唯一喂入入口，「live ≡ reload」两条链路共用本入口。
 *
 * case 覆盖（pi SessionEntry 全集）：message（role 细分 user/assistant/toolResult/
 * bashExecution/compactionSummary/custom/branchSummary）/ custom / label / compaction /
 * branch_summary / custom_message；未建模类型（thinking_level_change / model_change /
 * session_info / 未来的新类型）走 default no-op——「converter 不丢弃任何 pi entry 类型」
 * （父文档规则 #9）指不崩溃、不中断重放、不静默吞掉后续 entry；元数据类 entry 本身不产出
 * 对话流消息。
 */
export function applyEntry(state: ChatViewState, entry: PiEntry): ChatViewState {
  switch (entry.type) {
    case 'message':
      return applyMessageEntry(state, entry)
    case 'compaction':
      return applyCompactionEntry(state, entry)
    case 'branch_summary':
      return applyBranchSummaryEntry(state, entry)
    case 'custom_message':
      return applyCustomMessageEntry(state, entry)
    case 'custom':
      return applyClientMsgIdEntry(state, entry)
    case 'label': {
      // 用户书签/标记：重放侧无对话流投影，显式 no-op（规则 #9：有 case、不丢弃、不崩溃）。
      return state
    }
    default: {
      // 未建模 entry 类型（thinking_level_change / model_change / session_info / pi 未来新增）
      // → no-op。重放不中断，后续 entry 照常投影；类型清单见 pi session-manager.ts SessionEntry。
      return state
    }
  }
}

/**
 * 逐条 fold entry 序列 → 最终视图态（重放驱动器）。
 *
 * 文件重放路径（getHistory → hydrate，W20）与实时 feed（W21）共用的喂入形态：
 * `entries.reduce(applyEntry, initial ?? createInitialChatViewState())` 的显式封装。
 */
export function replayEntries(entries: PiEntry[], initial?: ChatViewState): ChatViewState {
  let state = initial ?? createInitialChatViewState()
  for (const entry of entries) {
    state = applyEntry(state, entry)
  }
  return state
}
