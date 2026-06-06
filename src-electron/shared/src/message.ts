export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'streaming' | 'complete' | 'error'
export type ToolCallStatus = 'running' | 'completed' | 'error'
export type ApprovalStatus = 'pending' | 'approved' | 'denied'

export interface ToolCall {
  id: string
  toolName: string
  input: unknown
  output?: string
  /** pi tool_execution_end result.details — 结构化扩展数据 */
  details?: Record<string, unknown>
  /** Extension tool_call_update 进度百分比 (0-100) */
  progress?: number
  /** Extension tool_call_update 详细信息 */
  detail?: string | Record<string, unknown>
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
  /** 当消息通过 skill 命令触发时设置 */
  skillName?: string
  /** SKILL.md 文件路径，从 <skill location="..."> 中提取 */
  skillLocation?: string
}
