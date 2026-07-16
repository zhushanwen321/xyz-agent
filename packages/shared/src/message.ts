import type { Segment } from './segments'

export type MessageRole = 'user' | 'assistant' | 'system'

/** steer / follow-up 发送模式（appendPending / removePending / markPendingDelivered 共用）。
 *  从 Message.sendMode 的子集抽出，避免 'steer' | 'follow-up' 字面量在三处手写漂移。 */
export type SteerFollowUpMode = 'steer' | 'follow-up'
/**
 * 'pending'：steer/followup 已入队 pi 但尚未投递（draft-composer-states S7）。
 * 投递（pi drain + queue_update 移除该项）时转 'complete'，与普通 user 气泡同形态。
 */
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'pending'
export type ToolCallStatus = 'running' | 'completed' | 'error' | 'end_not_received'

export interface ToolCall {
  id: string
  toolName: string
  input: unknown
  output?: string
  /** tool result 原始文本（含 ANSI 转义，未经 stripAnsi）。前端用 ansi_up 渲染着色。
   *  无此字段时回退到 output（已 stripAnsi 的纯文本）。 */
  outputRaw?: string
  /** pi tool_execution_end result.details — 结构化扩展数据 */
  details?: Record<string, unknown>
  /** Extension tool_call_update 进度百分比 (0-100) */
  progress?: number
  /** Extension tool_call_update 详细信息。
   *  subagent sync 模式下存 pi-subagents 推送的 AgentProgress 快照（聚合摘要：
   *  currentTool/turnCount/tokens/recentTools 等），前端据此滚动更新 subagent 行。 */
  detail?: string | Record<string, unknown>
  /** 实时流式失败（tool_execution_end isError）时的错误文本，与 status:'error' 同源 */
  error?: string
  status: ToolCallStatus
  startTime: number
  endTime?: number
}

export interface ThinkingBlock {
  id: string
  content: string
  collapsed: boolean
  /** Thinking 开始的毫秒时间戳（由后端 thinking_start 事件或会话记录提供） */
  startTime?: number
  /** Thinking 结束的毫秒时间戳（由后端 thinking_end 事件提供） */
  endTime?: number
}

/** 有序内容块类型，保证流式消息各 block 按到达顺序渲染 */
export type ContentBlockType = 'thinking' | 'toolCall' | 'text'

export interface ContentBlock {
  type: ContentBlockType
  /** thinking/toolCall 指向对应数组的元素 id；text 指向 'text' */
  refId: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

/** 上下文压缩摘要（W07-C，对应 message.compactionSummary） */
export interface CompactionSummary {
  summary?: string
  tokensBefore?: number
  timestamp?: number
}

/** 分支摘要（W07-C，对应 message.branchSummary） */
export interface BranchSummary {
  summary?: string
  fromId?: string
  timestamp?: number
}

/**
 * Background subagent 完成通知的单条记录。
 *
 * 对应 pi-subagents 扩展 notifier.ts 的 BgNotifyRecord，经 customType:"subagent-bg-notify"
 * 的 CustomMessage details 传递。pi-subagents 在主对话流注入此通知，triggerTurn:true 唤醒
 * 父 agent 接力处理结果。
 *
 * 来源：~/.xyz-agent/pi/agent/extensions/subagents/src/runtime/execution/notifier.ts
 */
export interface BgNotifyRecord {
  id: string
  /** 'done' | 'failed' | 'cancelled'（pi-subagents 的状态枚举） */
  status: 'done' | 'failed' | 'cancelled'
  agent: string
  /** 执行所用 model（用于通知展示） */
  model?: string
  /** done 状态的完成结果文本（进 LLM context，不截断） */
  result?: string
  /** failed 状态的错误文本 */
  error?: string
  startedAt: number
  endedAt?: number
  /** fork+worktree 模式下子 agent 改动的 patch 路径（worktree cleanup 后留存）。
   *  done 时通知显式提示 git apply，否则改动会静默丢失。 */
  patchFile?: string
}

/**
 * Background subagent 完成通知（单条或批量合并）。
 *
 * pi-subagents notifier 的滑动窗口在 60s 内合并多个完成，批量时 details 为 {batch, items}。
 * 单条时 details 直接是 BgNotifyRecord。
 */
export type BgNotifyDetails = BgNotifyRecord | { batch: true; items: BgNotifyRecord[] }

/**
 * 防御性解析 customType:"subagent-bg-notify" 的 details 字段。
 *
 * details 两种形态（notifier.ts flushPendingNotifications）：
 *   - 单条：BgNotifyRecord
 *   - 批量：{ batch: true, items: BgNotifyRecord[] }
 *
 * runtime（convertPiHistory）与 renderer（customStart effect）共用此纯函数，
 * 避免两处重复实现 + 字段读取不一致。任何字段缺失/类型异常返回 null（渲染层降级为纯文本）。
 */
export function parseBgNotifyDetails(details: unknown): BgNotifyDetails | null {
  if (!details || typeof details !== 'object') return null
  const d = details as Record<string, unknown>
  // 批量形态
  if (d.batch === true && Array.isArray(d.items)) {
    const items = d.items.map(parseSingleRecord).filter((r): r is BgNotifyRecord => r !== null)
    return items.length > 0 ? { batch: true, items } : null
  }
  // 单条形态
  return parseSingleRecord(d)
}

/** 防御性解析单条 BgNotifyRecord（必需字段 id/status/agent/startedAt 缺失返回 null） */
function parseSingleRecord(d: Record<string, unknown>): BgNotifyRecord | null {
  const id = typeof d.id === 'string' ? d.id : null
  const status = d.status === 'done' || d.status === 'failed' || d.status === 'cancelled' ? d.status : null
  const agent = typeof d.agent === 'string' ? d.agent : null
  const startedAt = typeof d.startedAt === 'number' ? d.startedAt : null
  if (!id || !status || !agent || startedAt === null) return null
  const record: BgNotifyRecord = { id, status, agent, startedAt }
  if (typeof d.model === 'string') record.model = d.model
  if (typeof d.result === 'string') record.result = d.result
  if (typeof d.error === 'string') record.error = d.error
  if (typeof d.endedAt === 'number') record.endedAt = d.endedAt
  if (typeof d.patchFile === 'string') record.patchFile = d.patchFile
  return record
}

// ── Flow-2 代码变更审查数据契约（FileChanges 通道）──────────────────
// 依据：docs/page-design/v3/flow-2-code-review/spec.md（§S3 变更集聚合 + §状态机·变更集卡）
//      .v3-audit/results/wave-W11-message-stream.md WP-L3-11（FileChanges 块缺失）
//      .v3-audit/results/wave-W14-side-drawer.md WP-L3-34（ChangeSet Detail 依赖本通道）
// 本契约只定义类型，runtime 解析方案见 ADR-0024，chat store 数据流由 flow-2 完整实施落地。

/**
 * 单个文件的变更状态。映射 pi 工具语义 + git A/M/D/U：
 * - write 新建文件 → added；覆盖既有文件 → modified
 * - edit 永远 → modified
 * - bash 驱动的删除/移动 → deleted（需 git 对账判定，见 ADR-0024）
 * - unmerged → git 冲突态（由 runtime git.status 推送，见 protocol.ts GitFileStatus；
 *   file_changes 与 git.status 共用本枚举，FR-11/C15）
 */
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'unmerged'

/**
 * 单个文件的变更记录。挂在 assistant message 上（见 Message.fileChanges）。
 * filePath 为相对工作根的路径（pi write/edit 工具 args.path 已 resolveToCwd 归一）。
 * addLines/delLines 为可选：edit 工具可从 details.patch 解析；write 新文件无基线 diff，
 * bash 改动需 git 对账才有，故非必填。
 */
export interface FileChange {
  filePath: string
  status: FileChangeStatus
  addLines?: number
  delLines?: number
}

/**
 * 变更集卡 5 态状态机（flow-2 spec §状态机·变更集卡）。
 * accumulating：agent 仍在改，文件数实时增长（带 loading 指示）
 * ready：agent 完成回合，等待用户审查
 * partially-reviewed：部分文件已 accept/reject
 * resolved：全部处理完，变更集卡折叠
 * superseded：agent 又改了一轮，旧变更集折叠归档
 */
export type ChangeSetStatus = 'accumulating' | 'ready' | 'partially-reviewed' | 'resolved' | 'superseded'

/**
 * 单文件审查决策（W14 ChangeSet Detail Accept/Reject 用）。
 * pending 为初始默认值，accepted/rejected 由用户在 Side Drawer 落定。
 */
export type ReviewDecision = 'pending' | 'accepted' | 'rejected'

export interface Message {
  id: string
  role: MessageRole
  /**
   * 消息内容。按 role 语义区分（ADR-0037）：
   * - user message → Segment[]（badge 载体，含 skill/file/mention 结构化片段）
   * - assistant message → string（流式 text_delta 热路径）
   * - system/custom message → string（提示文本）
   *
   * 消费纯文本时用 normalizeContent() 归一化（处理 string | Segment[] 联合类型）。
   */
  content: string | Segment[]
  status: MessageStatus
  toolCalls?: ToolCall[]
  thinking?: ThinkingBlock[]
  /** 有序内容块，记录 thinking/toolCall/text 的实际到达顺序 */
  contentBlocks?: ContentBlock[]
  usage?: Usage
  timestamp: number
  /**
   * 该 assistant 消息产生的文件变更集合（flow-2 FileChanges 通道）。
   * runtime 经 pi 工具事件解析后推送，变更集卡（W11 WP-L3-11）据此渲染。
   * 仅 assistant 消息有值；user/system 消息不设置。
   */
  fileChanges?: FileChange[]
  /** 发送模式，仅 user 消息有值 */
  sendMode?: 'send' | 'steer' | 'follow-up'
  /** 是否被 abort 中断，仅 assistant 消息有值 */
  isInterrupted?: boolean
  /** 上下文压缩摘要（W07-C，message.compactionSummary） */
  compactionSummary?: CompactionSummary
  /** 分支摘要（W07-C，message.branchSummary） */
  branchSummary?: BranchSummary
  /** pi CustomMessage 的 customType（识别来源扩展，如 "subagent-bg-notify"）。
   *  来自 pi sendMessage 注入的 custom message，role 还原为 system。 */
  customType?: string
  /** Background subagent 完成通知（customType:"subagent-bg-notify" 时填充）。 */
  bgNotify?: BgNotifyDetails
  /** pi CustomMessage details 原始字段（含 __gui__ 结构化渲染数据）。
   *  前端检测 details.__gui__ 路由到 GuiComponentRenderer。 */
  details?: Record<string, unknown>
  /**
   * pi session JSONL 中对应 entry 的 id（entry 树节点标识）。
   * 仅文件路径读取（session-history）时填充——RPC 路径（pi get_messages）不返回 entryId。
   * fork session 时用于在 pi 端定位截断点（runtime 按 piEntryId 在 JSONL 树回溯截断）。
   * 缺失时（在线重开的 session 走 RPC）fork 需 fallback 读 JSONL 按 timestamp 匹配。
   */
  piEntryId?: string
}
