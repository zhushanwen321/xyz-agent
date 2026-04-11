// 与 Rust AgentEvent #[serde(tag = "type")] 对应
export type AgentEvent =
  | { type: 'TextDelta'; session_id: string; delta: string }
  | { type: 'ThinkingDelta'; session_id: string; delta: string }
  | { type: 'MessageComplete'; session_id: string; role: string; content: string; usage: TokenUsage }
  | { type: 'TurnComplete'; session_id: string }
  | { type: 'Error'; session_id: string; message: string }
  | { type: 'ToolCallStart'; session_id: string; tool_name: string; tool_use_id: string; input: unknown }
  | { type: 'ToolCallEnd'; session_id: string; tool_use_id: string; is_error: boolean; output: string }
  // dispatch_agent events
  | { type: 'TaskCreated'; session_id: string; task_id: string; description: string; mode: string; subagent_type: string; budget: { max_tokens: number }; tool_use_id: string | null }
  | { type: 'TaskProgress'; session_id: string; task_id: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number } }
  | { type: 'TaskCompleted'; session_id: string; task_id: string; status: string; result_summary: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number } }
  | { type: 'BudgetWarning'; session_id: string; task_id: string; usage_percent: number }
  | { type: 'TaskFeedback'; session_id: string; task_id: string; message: string; severity: string }
  // orchestrate events
  | { type: 'OrchestrateNodeCreated'; session_id: string; node_id: string; parent_id: string | null; role: string; depth: number; description: string }
  | { type: 'OrchestrateNodeProgress'; session_id: string; node_id: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number } }
  | { type: 'OrchestrateNodeCompleted'; session_id: string; node_id: string; status: string; result_summary: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number } }
  | { type: 'OrchestrateNodeIdle'; session_id: string; node_id: string }
  | { type: 'OrchestrateFeedback'; session_id: string; node_id: string; direction: string; message: string; severity: string }

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
  segments?: AssistantSegment[]  // 新增：仅 assistant 消息使用
  timestamp: string
  isStreaming?: boolean
  toolCalls?: ToolCallDisplay[]  // 保留，向后兼容但不再使用
}

/** 用于渲染的工具调用信息 */
export interface ToolCallDisplay {
  tool_use_id: string
  tool_name: string
  input: unknown
  status: 'running' | 'completed' | 'error'
  output?: string
}

/** Assistant 消息内的有序片段 */
export type AssistantSegment =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCallDisplay }

/** 工具危险等级 */
export type ToolDangerLevel = 'safe' | 'caution'

/** 工具危险等级映射 */
export const TOOL_DANGER_LEVEL: Record<string, ToolDangerLevel> = {
  Read: 'safe',
  Bash: 'caution',
  Write: 'caution',
}

export function getToolDangerLevel(toolName: string): ToolDangerLevel {
  return TOOL_DANGER_LEVEL[toolName] ?? 'caution'
}

export interface SessionInfo {
  id: string
  title: string
  created_at: string
  updated_at: string
}

// 与 Rust LoadHistoryResult 对应
export interface TaskNode {
  type: 'task_node'
  task_id: string
  session_id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'budget_exhausted' | 'killed' | 'paused'
  mode: 'preset' | 'fork'
  subagent_type: string | null
  budget: { max_tokens: number; max_turns: number; max_tool_calls: number }
  usage: { total_tokens: number; tool_uses: number; duration_ms: number }
  created_at: string
  completed_at: string | null
  output_file: string | null
}

export interface OrchestrateNode {
  type: 'orchestrate_node'
  node_id: string
  parent_id: string | null
  session_id: string
  role: 'orchestrator' | 'executor'
  depth: number
  description: string
  status: 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'budget_exhausted' | 'killed' | 'paused'
  directive: string
  budget: { max_tokens: number; max_turns: number; max_tool_calls: number }
  usage: { total_tokens: number; tool_uses: number; duration_ms: number }
  feedback_history: Array<{ timestamp: string; direction: string; message: string; severity: string }>
  reuse_count: number
  children_ids: string[]
}

export interface LoadHistoryResult {
  entries: TranscriptEntry[]
  conversation_summary: string | null
  task_nodes: TaskNode[]
  orchestrate_nodes: OrchestrateNode[]
  pending_async_results: Array<{
    task_id: string
    description: string
    status: string
    result_summary: string
  }>
}

// 与 Rust AgentConfig 对应
export interface ConfigResponse {
  anthropic_api_key: string
  llm_model: string
  anthropic_base_url: string
  max_turns: number
  context_window: number
  max_output_tokens: number
  tool_output_max_bytes: number
  bash_default_timeout_secs: number
}

export interface UpdateConfigRequest {
  anthropic_api_key: string
  llm_model: string
  anthropic_base_url: string
  max_turns: number
  context_window: number
  max_output_tokens: number
  tool_output_max_bytes: number
  bash_default_timeout_secs: number
}
