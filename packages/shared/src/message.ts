export type MessageRole = 'user' | 'assistant' | 'system'
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
  /** subagent async 模式的后台 run id（asyncId ↔ toolCallId 关联用）。
   *  async 模式 tool_call_end 时从 details.asyncId 提取；sync 模式缺省。
   *  后续 subagent:async-complete 事件带 asyncId 到达时，据此定位并更新对应 ToolCall。 */
  asyncId?: string
  /** subagent async 后台 run 的状态（仅 async 模式有值）。
   *  - 'dispatched':async 已派发，等待后台 run 完成（tool_call_end 时设置）
   *  - 'completed'/'failed'/'paused':收到 subagent:async-complete 后更新 */
  asyncState?: 'dispatched' | 'completed' | 'failed' | 'paused'
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

/**
 * Bash 执行记录（W07-C，对应 message.bashExecution）。
 * 来自 pi message_start{role:'bashExecution'}，经 event-adapter 翻译。
 * 作 system 提示行渲染（非 user/assistant）；exitCode/truncated/fullOutputPath 体现执行结果。
 */
export interface BashExecution {
  command?: string
  output?: string
  exitCode?: number
  cancelled?: boolean
  truncated?: boolean
  fullOutputPath?: string
  timestamp?: number
  excludeFromContext?: boolean
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
  content: string
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
  /** 当消息通过 skill 命令触发时设置 */
  skillName?: string
  /** SKILL.md 文件路径，从 <skill location="..."> 中提取 */
  skillLocation?: string
  /** 发送模式，仅 user 消息有值 */
  sendMode?: 'send' | 'steer' | 'follow-up'
  /** 是否被 abort 中断，仅 assistant 消息有值 */
  isInterrupted?: boolean
  /**
   * Bash 执行记录（W07-C，message.bashExecution）。
   * 来自 pi message_start{role:'bashExecution'}；作 system 提示行渲染。
   */
  bashExecution?: BashExecution
  /** 上下文压缩摘要（W07-C，message.compactionSummary） */
  compactionSummary?: CompactionSummary
  /** 分支摘要（W07-C，message.branchSummary） */
  branchSummary?: BranchSummary
}
