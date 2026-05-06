export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: ToolCall[]
  thinking?: ThinkingBlock[]
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  timestamp: number
}

export interface ToolCall {
  id: string
  toolName: string
  input: string
  output?: string
  status: 'running' | 'completed' | 'error'
}

export interface ThinkingBlock {
  id: string
  content: string
}
