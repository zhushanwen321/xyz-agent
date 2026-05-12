export type MessageRole = 'user' | 'assistant'
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
  usage?: Usage
  timestamp: number
  /** 当消息通过 skill 命令触发时设置 */
  skillName?: string
}
