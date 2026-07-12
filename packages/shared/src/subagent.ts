/**
 * Subagent 数据模型 —— 从主 session JSONL 的 subagent toolCall/toolResult 提取。
 *
 * 数据来源：pi-subagent-workflow 扩展注册的 `subagent` tool。主 agent 调用该 tool
 * 时，扩展 spawn 一个子 agent（独立 pi session，JSONL 落在
 * `~/.xyz-agent/pi/agent/subagents/<encodeCwd(mainCwd)>/sessions/*.jsonl`）。
 *
 * toolCall 携带 action=start + startParam{agent, task, wait}；
 * toolResult 携带 subagentId + sessionFile + syncResponse|bgResponse|listResponse。
 * runtime 的 subagent-extractor 从主 session JSONL 配对解析出 SubagentRecord[]。
 */

/** subagent 执行模式 */
export type SubagentMode = 'sync' | 'background'

/** subagent 状态（统一 sync/background） */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'cancelled'

/**
 * 单条 subagent 记录（列表项数据）。
 *
 * 字段来源对应关系：
 * - subagentId：toolResult.subagentId（如 "run-xxx-1" 或 "bg-xxx-timestamp"）
 * - sessionFile：toolResult.sessionFile（subagent JSONL 绝对路径，background 模式可能为 null → listResponse 补全）
 * - agent/task：toolCall.startParam
 * - status/mode/turns/tokens/elapsed：syncResponse（sync 模式）或 listResponse.items[0]（background 模式）
 * - startedAt/endedAt：bg-notify details（background 模式完成时），或 syncResponse 的时间戳推导
 */
export interface SubagentRecord {
  /** subagent 唯一标识（toolResult.subagentId） */
  subagentId: string
  /** subagent session JSONL 文件路径（对话流读取用；可能为 null = 文件已被清理或未创建） */
  sessionFile: string | null
  /** agent 名称（如 "reviewer" / "general-purpose" / "worker"） */
  agent: string
  /** 分配给 subagent 的任务描述 */
  task: string
  /** 执行模式：sync（阻塞等待）/ background（后台执行） */
  mode: SubagentMode
  /** 当前状态 */
  status: SubagentStatus
  /** 执行所用 model（展示用） */
  model?: string
  /** 完成的对话轮数 */
  turns?: number
  /** 总 token 消耗 */
  totalTokens?: number
  /** 执行耗时（秒） */
  elapsedSeconds?: number
  /** 启动时间戳（ms） */
  startedAt?: number
  /** 结束时间戳（ms，终态时有值） */
  endedAt?: number
  /** failed 状态的错误文本 */
  error?: string
}
