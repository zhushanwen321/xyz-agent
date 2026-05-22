export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'streaming' | 'complete' | 'error'
export type ToolCallStatus = 'running' | 'completed' | 'error'
export type ApprovalStatus = 'pending' | 'approved' | 'denied'

export interface ToolCall {
  id: string
  toolName: string
  input: unknown
  output?: string
  status: ToolCallStatus
  startTime: number
  endTime?: number
}

export interface ThinkingBlock {
  id: string
  content: string
  collapsed: boolean
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
}
