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
 * subagent 状态。对齐 pi-subagent-workflow v4 ExecutionStatus 两态：
 * - running：执行中，或对话模式轮次完成等待续聊（非终态）
 * - closed：统一终态（done/failed/crashed/cancelled 合并），L2 原因由 closedReason 表达
 *
 * done/failed/cancelled/crashed 为 legacy 兼容值：v4 之前旧版扩展产物 + manifest 旧值
 * （completed/failed/cancelled）读侧归一需要，v4 起扩展不再产出，仅为历史 session 数据保留。
 */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'crashed' | 'closed'

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
  /**
   * L2 关闭原因（仅 status='closed' 时有意义）。对齐 extension 侧 ClosedReason 六值
   * （extensions/subagent-workflow/src/execution/types.ts）：
   * 'parent-shutdown' | 'parent-fork' | 'parent-new' | 'user-close' | 'cancelled' | 'gc'。
   * event-interpreter（bg-notify 实时路径）与 subagent-extractor（JSONL 磁盘路径）投影，
   * UI 侧经 deriveClosedDisplay 派生成功/失败/取消展示语义。用 string 而非字面量联合：
   * shared 是跨进程契约 SSOT，extension 新增 reason 值时读侧不因类型收窄丢字段。
   */
  closedReason?: string
}

/**
 * 将 pi-subagent-workflow 各出口的状态字符串归一化为 SubagentStatus。
 *
 * pi 侧状态来源分散且命名不一致（v4 bg-notify 发 running/closed、listResponse 给
 * running/closed、PR #85 的 manifest 写 completed/failed、子进程崩溃重建路径推断
 * crashed），本函数统一收敛到 SubagentStatus（v4 两态 + legacy 兼容值）。
 *
 * runtime 的 event-interpreter（实时路径）与 subagent-extractor（磁盘路径）共用此函数，
 * 避免两处手写三元/switch 漂移（历史 bug：event-interpreter 的三元缺 completed/crashed 归一）。
 */
export function normalizeSubagentStatus(status: string | undefined): SubagentStatus {
  if (!status) return 'running'
  switch (status) {
    case 'done':
    case 'completed':
    case 'success':
      return 'done'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'crashed':
      return 'crashed'
    case 'running':
    case 'pending':
    case 'active':
      return 'running'
    case 'closed':
      return 'closed'
    default:
      // 未知状态：pi 扩展可能新增了未映射的状态，warn 一次便于排查。
      // 兜底方向取终态（closed）而非 running：未知值更可能是扩展新增的终态细分，
      // 返回 running 会把已结束的 subagent 翻回「运行中」假象（UI 永久 spinner、
      // 活跃任务误判）；「无状态信息」（undefined/空串）才保持初始 running 认知。
      console.warn(`[normalizeSubagentStatus] unknown status: ${JSON.stringify(status)}, falling back to 'closed'`)
      return 'closed'
  }
}

/**
 * closed 统一终态的展示语义（UI 渲染派生，v4 B-1 两态收敛的配套）。
 *
 * extension v4 起 bg-notify / list 只产出 status='closed'（含失败/取消），L2 原因由
 * closedReason 表达。渲染层（renderer BgNotifyCard / SubagentList）不再各自手写
 * 派生规则，统一消费本函数：
 * - closedReason='cancelled' → cancelled（取消，中性样式）
 * - error 有值 → failed（closedReason='gc' 失败终态携带 error；不限定 gc——
 *   closedReason 缺失的 legacy 数据 + error 同样是失败信号）
 * - 其余 → done（自然完成 / parent-fork / parent-new / user-close 等级联关闭）
 *
 * 与 extension TUI 侧（bg-notify-render.ts renderRecordLines）的 verb 派生规则一致。
 */
export type ClosedDisplayStatus = 'done' | 'failed' | 'cancelled'

/** 从 closed 终态记录派生展示语义（输入 status 必须已是终态；running/round 由调用方自行处理） */
export function deriveClosedDisplay(input: { closedReason?: string; error?: string }): ClosedDisplayStatus {
  if (input.closedReason === 'cancelled') return 'cancelled'
  if (input.error) return 'failed'
  return 'done'
}
