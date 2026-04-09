// 与 Rust AgentEvent #[serde(tag = "type")] 对应
export type AgentEvent =
  | { type: 'TextDelta'; session_id: string; delta: string }
  | { type: 'ThinkingDelta'; session_id: string; delta: string }
  | { type: 'MessageComplete'; session_id: string; role: string; content: string; usage: TokenUsage }
  | { type: 'Error'; session_id: string; message: string }
  | { type: 'ToolCallStart'; session_id: string; tool_name: string; tool_use_id: string }
  | { type: 'ToolCallEnd'; session_id: string; tool_use_id: string; is_error: boolean }

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

// 与 Rust ContentBlock 对应
export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }

// 与 Rust TranscriptEntry 对应
export type TranscriptEntry =
  | { type: 'user'; uuid: string; parent_uuid: string | null; timestamp: string; session_id: string; content: UserContentBlock[] }
  | { type: 'assistant'; uuid: string; parent_uuid: string | null; timestamp: string; session_id: string; content: AssistantContentBlock[]; usage: TokenUsage | null }
  | { type: 'system'; uuid: string; parent_uuid: string | null; timestamp: string; session_id: string; content: string }

// 前端内部使用的消息模型
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  isStreaming?: boolean
}

export interface SessionInfo {
  id: string
  title: string
  created_at: string
  updated_at: string
}

// 与 Rust LoadHistoryResult 对应
export interface LoadHistoryResult {
  entries: TranscriptEntry[]
  conversation_summary: string | null
}
