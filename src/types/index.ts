// 与 Rust AgentEvent #[serde(tag = "type")] 对应
export type AgentEvent =
  | { type: 'TextDelta'; session_id: string; delta: string; source_task_id?: string }
  | { type: 'ThinkingDelta'; session_id: string; delta: string; source_task_id?: string }
  | { type: 'MessageComplete'; session_id: string; role: string; content: string; usage: TokenUsage; source_task_id?: string }
  | { type: 'TurnComplete'; session_id: string; source_task_id?: string }
  | { type: 'Error'; session_id: string; message: string; source_task_id?: string }
  | { type: 'ToolCallStart'; session_id: string; tool_name: string; tool_use_id: string; input: unknown; source_task_id?: string }
  | { type: 'ToolCallEnd'; session_id: string; tool_use_id: string; is_error: boolean; output: string; source_task_id?: string }
  // dispatch_agent events
  | { type: 'TaskCreated'; session_id: string; task_id: string; description: string; mode: string; subagent_type: string; budget: { max_tokens: number }; tool_use_id: string | null; source_task_id?: string }
  | { type: 'TaskProgress'; session_id: string; task_id: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number }; source_task_id?: string }
  | { type: 'TaskCompleted'; session_id: string; task_id: string; status: string; result_summary: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number }; source_task_id?: string }
  | { type: 'BudgetWarning'; session_id: string; task_id: string; usage_percent: number; source_task_id?: string }
  | { type: 'TaskFeedback'; session_id: string; task_id: string; message: string; severity: string; source_task_id?: string }
  // orchestrate events
  | { type: 'OrchestrateNodeCreated'; session_id: string; node_id: string; parent_id: string | null; role: string; depth: number; description: string; source_task_id?: string }
  | { type: 'OrchestrateNodeProgress'; session_id: string; node_id: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number }; source_task_id?: string }
  | { type: 'OrchestrateNodeCompleted'; session_id: string; node_id: string; status: string; result_summary: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number }; source_task_id?: string }
  | { type: 'OrchestrateNodeIdle'; session_id: string; node_id: string; source_task_id?: string }
  | { type: 'OrchestrateFeedback'; session_id: string; node_id: string; direction: string; message: string; severity: string; source_task_id?: string }

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
  | { type: 'custom_title'; title: string; uuid: string; timestamp: string }
  | { type: 'summary'; content: string; uuid: string; timestamp: string }
  | { type: 'task_node'; task_id: string; uuid: string; timestamp: string }
  | { type: 'orchestrate_node'; node_id: string; uuid: string; timestamp: string }
  | { type: 'feedback'; content: string; uuid: string; timestamp: string }

// 前端内部使用的消息模型
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  segments?: AssistantSegment[]
  timestamp: string
  isStreaming?: boolean
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
  | { type: 'thinking'; text: string; duration_ms: number }

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

// 任务/节点共有状态（与 Rust TaskStatus 对应）
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'budget_exhausted' | 'killed' | 'paused'

// 与 Rust LoadHistoryResult 对应
export interface TaskNode {
  type: 'task_node'
  task_id: string
  session_id: string
  description: string
  status: TaskStatus
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
  status: TaskStatus | 'idle'
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
  thinking_enabled: boolean
  thinking_budget_tokens: number
}

export type UpdateConfigRequest = ConfigResponse

// Tab 状态
export type TabStatus = 'completed' | 'thinking' | 'streaming' | 'tool' | 'failed' | 'idle'

// Tab 数据模型
export interface ChatTab {
  id: string
  type: 'main' | 'subagent' | 'orchestrate'
  title: string
  session_id: string
  sidechain_id?: string
  status: TabStatus
  closable: boolean
}

// 与 Rust PromptInfo 对应
export interface PromptInfo {
  key: string
  mode: 'builtin' | 'enhance' | 'override' | 'custom'
  content: string
  has_enhance: boolean
  has_override: boolean
  tools: string[]
  description: string
  read_only: boolean
  max_tokens: number
  max_turns: number
  max_tool_calls: number
}

// 自定义 Agent 保存请求
export interface CustomAgentInput {
  name: string
  content: string
  tools: string[]
  description: string
  read_only: boolean
  max_tokens: number
  max_turns: number
  max_tool_calls: number
}

// Prompt 保存请求
export interface PromptSaveInput {
  key: string
  mode: 'enhance' | 'override'
  content: string
}

// 与 Rust ToolInfo 对应
export interface ToolInfo {
  name: string
  description: string
  input_schema: unknown
  is_concurrent_safe: boolean
  timeout_secs: number
  danger_level: 'safe' | 'caution'
  enabled: boolean
  has_override: boolean
}

// 工具配置保存请求
export interface ToolConfigSaveInput {
  name: string
  description?: string
  timeout_secs?: number
  enabled?: boolean
}
