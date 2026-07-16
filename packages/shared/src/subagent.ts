/**
 * Subagent 数据模型 —— 从主 session JSONL 的 subagent toolCall/toolResult 提取。
 *
 * 数据来源：pi-subagent-workflow 扩展注册的 `subagent` tool。主 agent 调用该 tool
 * 时，扩展 spawn 一个子 agent（独立 pi session，JSONL 落在
 * `~/.xyz-agent/pi/agent/subagents/<encodeCwd(mainCwd)>/sessions/*.jsonl`）。
 *
 * toolCall 携带 action=start + startParam{task, slug, agent?, model?, thinkingLevel?, fork?, worktree?, ...}；
 * toolResult 携带 subagentId + sessionFile + bgResponse|listResponse。
 * runtime 的 subagent-extractor 从主 session JSONL 配对解析出 SubagentRecord[]。
 *
 * 2026-07-13 对齐 pi-subagent-workflow feat-ask-user-gui 分支：
 * - 新增 slug（短标签 ≤20 字符，必填，区分并发 subagent）
 * - 移除 mode 字段（新版只有 background，无 sync 模式）
 * - 旧 session JSONL（startParam 无 slug）反序列化时 slug 兜底空串
 */

/**
 * subagent 状态。
 * crashed 为子进程崩溃终态（进程退出码非 0 且非正常 cancel）。
 * 对齐 pi-subagent-workflow ExecutionStatus。
 */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'crashed'

/**
 * 单条 subagent 记录（列表项数据）。
 *
 * 字段来源对应关系：
 * - subagentId：toolResult.subagentId（如 "bg-xxx-1-1234567890"）
 * - sessionFile：toolResult.sessionFile（subagent JSONL 绝对路径，可能为 null → listResponse 补全）
 * - slug/task/agent：toolCall.startParam（slug 短标签、task 完整提示词、agent 类型名）
 * - status/turns/tokens/elapsed：listResponse.items[0] 或 bg-notify details
 * - startedAt/endedAt：bg-notify details（完成时）
 */
export interface SubagentRecord {
  /** subagent 唯一标识（toolResult.subagentId） */
  subagentId: string
  /** subagent session JSONL 文件路径（对话流读取用；可能为 null = 文件已被清理或未创建） */
  sessionFile: string | null
  /** agent 名称（如 "reviewer" / "general-purpose" / "worker"） */
  agent: string
  /** 短标签（≤20 字符），区分并发 subagent。旧 session 无此字段时兜底空串 */
  slug: string
  /** 分配给 subagent 的完整任务提示词（可多行） */
  task: string
  /** 当前状态 */
  status: SubagentStatus
  /** 执行所用 model（展示用） */
  model?: string
  /** 思考等级（off/minimal/low/medium/high/xhigh） */
  thinkingLevel?: string
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
