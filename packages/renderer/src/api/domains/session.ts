/**
 * Session 域 —— list/create/switchSession。
 *
 * 依赖方向：transport + pending（经 request helper 统一发送 ClientMessage 并关联 Promise）。
 *
 * 注：方法名用 switchSession 而非 switch（switch 是 TS 保留字）。
 * 注：ServerMessage(id) → pending.resolve 的回灌由 features 层 dispatcher 串联（Wave 3）。
 *      mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { SessionSummary, SessionGroup, SubagentRecord, WorkflowRunRecord, Message, BatchDeleteResult, ServerMessage } from '@xyz-agent/shared'
import { command } from '../request'

/**
 * handoff RPC 超时：对齐 runtime HandoffService.HANDOFF_TIMEOUT_MS（600s）+ 60s 余量（agent_end 后的 create/broadcast）。
 * 不直接 import runtime 包（跨包依赖不可行），本地定义并手动对齐——runtime 改值时这里同步更新。
 * 不走 pending.ts DEFAULT_TIMEOUT_MS（65s）：65s 后前端 RPC 超时 reject → useHandoffActions 复位 handingOff（按钮可重点），
 * 但 runtime runHandoff 仍最长跑 600s，用户重试会撞 runtime already in progress。
 */
const HANDOFF_RPC_TIMEOUT_MS = 660_000

/**
 * 列出所有 session，按 cwd 分组（对齐后端 SessionGroup[]，D7）。
 * reply payload 是 { groups: SessionGroup[] }，解包 .groups。
 * type=config.sessions（原 session.list，W2 重命名）。
 */
export async function list(): Promise<SessionGroup[]> {
  const reply = await command('config.sessions', {})
  return reply.groups
}

/**
 * 创建新 session（#1 cwd 透传，位置参数 create(cwd?, label?)，issues #1 方案 A）。
 * cwd=undefined → payload 不含 cwd 键（runtime 回退 process.cwd()，AC-1.2 回归）。
 * presetId：session 创建时锁定的 pi 启动预设 id（设计文档 §4.1），透传给 runtime。
 * reply envelope 是 { session }，解包 .session。
 */
export async function create(cwd?: string, label?: string, presetId?: string): Promise<SessionSummary> {
  const payload: { cwd?: string; label?: string; presetId?: string } = {}
  if (cwd !== undefined) payload.cwd = cwd
  if (label !== undefined) payload.label = label
  if (presetId !== undefined) payload.presetId = presetId
  const reply = await command('session.create', payload)
  return reply.session
}

/** 切换到指定 session（id 无效时由 runtime/pending reject） */
export function switchSession(sessionId: string): Promise<void> {
  return command('session.switch', { sessionId })
}

/**
 * Fork session：从 srcSessionId 截断到 fromPiEntryId，创建新 session（独立 pi 进程）。
 * reply 复用 session.created，解包 .session。
 *
 * Staging Mode（ADR-0043）：modelOverride/thinkingOverride 来自 composer 暂存态，
 * 优先于源 session preset 的对应字段。
 */
export async function fork(
  srcSessionId: string,
  opts: {
    piEntryId?: string
    messageTimestamp?: number
    messageRole?: string
    includeFrom?: boolean
    label?: string
    modelOverride?: string
    thinkingOverride?: string
  },
): Promise<SessionSummary> {
  const reply = await command('session.fork', {
    srcSessionId,
    fromPiEntryId: opts.piEntryId,
    fromMessageTimestamp: opts.messageTimestamp,
    fromMessageRole: opts.messageRole,
    includeFrom: opts.includeFrom,
    label: opts.label,
    modelOverride: opts.modelOverride,
    thinkingOverride: opts.thinkingOverride,
  })
  return reply.session
}

/**
 * 拉取 session 的扩展命令（pi getCommands）。
 * 修复 broadcast 与订阅时序竞争：session.switch 的 ensureActive 内部 broadcast commands
 * 发生在 renderer 订阅建立之前会被丢弃；renderer 切 session 后主动调本方法拉取。
 */
export function getCommands(
  sessionId: string,
): Promise<{ sessionId: string; commands: Array<{ name: string; description?: string; source: string }> }> {
  return command('session.getCommands', { sessionId })
}

/**
 * 拉取 session 的当前上下文用量（pi get_session_stats.contextUsage）。
 * 修复 broadcast 与订阅时序竞争：restoreSession 内部兜底 broadcast 早于前端订阅，renderer 主动拉取。
 */
export function getContext(
  sessionId: string,
): Promise<{ sessionId: string; inputTokens: number; contextLimit: number; usagePercent: number }> {
  return command('session.getContext', { sessionId })
}

/** 重命名 session（label 更新） */
export function rename(sessionId: string, label: string): Promise<void> {
  return command('session.rename', { sessionId, name: label })
}

/** 删除 session（从列表移除） */
export function remove(sessionId: string): Promise<void> {
  return command('session.delete', { sessionId })
}

/** 删除指定 cwd（folder）下所有 session（folder 维度批量删除，reply 含 deleted/failed 列表） */
export function removeByCwd(cwd: string): Promise<BatchDeleteResult> {
  return command('session.deleteByCwd', { cwd })
}

/**
 * 设置 session 的思考等级（动作；确认由 session.thinkingLevelSet reply 回灌 pending）。
 * level 是前端 6 级枚举字符串（off/low/medium/high/xhigh/max，见 thinking-levels.ts）。
 */
export function setThinkingLevel(sessionId: string, level: string): Promise<void> {
  return command('session.setThinkingLevel', { sessionId, level })
}

/**
 * 获取 session 派生的 subagent 列表（runtime 从主 session JSONL 提取）。
 * reply payload 是 { sessionId, subagents }，解包 .subagents。
 */
export async function getSubagents(sessionId: string): Promise<SubagentRecord[]> {
  const reply = await command('session.getSubagents', { sessionId })
  return reply.subagents
}

/**
 * 获取 subagent 的对话流历史（runtime 直读 subagent JSONL）。
 * reply payload 是 { sessionId, subagentId, messages }，解包 .messages。
 */
export async function getSubagentHistory(sessionId: string, subagentId: string): Promise<Message[]> {
  const reply = await command('session.getSubagentHistory', { sessionId, subagentId })
  return reply.messages
}

/**
 * 获取 session 派生的 workflow 列表（runtime 从主 session JSONL 的 workflow-state-link 提取）。
 * reply payload 是 { sessionId, workflows }，解包 .workflows。
 */
export async function getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> {
  const reply = await command('session.getWorkflows', { sessionId })
  return reply.workflows
}

/**
 * 获取 workflow 内 agent call 的对话流历史（runtime 按 trace[].sessionId 查找 JSONL）。
 * reply payload 是 { sessionId, agentCallSessionId, messages }，解包 .messages。
 */
export async function getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<Message[]> {
  const reply = await command('session.getAgentCallHistory', { sessionId, agentCallSessionId })
  return reply.messages
}

/**
 * 解析 agent call 对话流 JSONL 绝对路径（PanelHeader overlay 文件名展示用）。
 * runtime 按 trace[].sessionId 在 subagents 目录查找，找不到返回空串（展示型功能不 throw）。
 */
export async function getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string> {
  const reply = await command('session.getAgentCallFilePath', { sessionId, agentCallSessionId })
  return reply.filePath
}

/**
 * 触发 workflow 生命周期操作（pause/resume/abort）。
 * runtime 经 client.prompt("/workflows <action> <runId>") 调扩展 slash command（不经 LLM）。
 */
export function workflowAction(
  sessionId: string,
  action: 'pause' | 'resume' | 'abort',
  runId: string,
): Promise<void> {
  return command('session.workflowAction', { sessionId, action, runId })
}

/**
 * 取消 running subagent（经扩展 /subagents cancel，不经 LLM）。
 * 对称 workflowAction，reply session.subagentActionDone。
 */
export function subagentAction(
  sessionId: string,
  action: 'cancel',
  subagentId: string,
): Promise<void> {
  return command('session.subagentAction', { sessionId, action, subagentId })
}

/**
 * 触发 fast-handoff（痛点3，FR-fast-handoff）。
 * runtime HandoffService 让源 session 跑 handoff turn 生成文档 → 新建 session 由 runtime 注入 doc。
 * 与 fork 的区别：fork 从某点分叉继承历史；handoff 不继承历史，只注入文档（"打包交接到新线程"）。
 * reply sanitize 后拼到 handoff prompt 末尾告知 agent 下一 session 关注点。完成经独立通道 session.handoffComplete 广播（effect 层订阅跳转），
 * reply 是 message.status ack（前端不读 payload，等广播）。
 */
/**
 * 触发 fast-handoff（痛点3，FR-fast-handoff）。
 * runtime HandoffService 让源 session 跑 handoff turn 生成文档 → 新建 session 由 runtime 注入 doc。
 * 与 fork 的区别：fork 从某点分叉继承历史；handoff 不继承历史，只注入文档（"打包交接到新线程"）。
 * reply sanitize 后拼到 handoff prompt 末尾告知 agent 下一 session 关注点。完成经独立通道 session.handoffComplete 广播（effect 层订阅跳转），
 * reply 是 message.status ack（前端不读 payload，等广播）。
 *
 * Staging Mode（ADR-0043）：modelOverride/thinkingOverride 来自 composer 暂存态的模型选择，
 * 用于新 session 创建（源 session turn 仍用源 session 自身模型，不受 override 影响）。
 */
export function handoff(
  sessionId: string,
  reply?: string,
  options?: { modelOverride?: string; thinkingOverride?: string },
): Promise<void> {
  return command('session.handoff', {
    sessionId,
    reply,
    modelOverride: options?.modelOverride,
    thinkingOverride: options?.thinkingOverride,
  }, HANDOFF_RPC_TIMEOUT_MS)
}

/**
 * 取消进行中的 handoff（委托 HandoffService.abortHandoff 中断 handoff inflight：client.abort + 清 listener/timer）。
 * 无进行中 handoff 时 no-op。reply message.status ack。
 */
export function abortHandoff(sessionId: string): Promise<void> {
  return command('session.abortHandoff', { sessionId })
}

/**
 * 订阅指定 session 的 live 事件流（runtime-message-bus slice，wave:protocol-seq + wave:runtime-wiring）。
 *
 * runtime 在订阅时刻返回：
 * - snapshot：bus ring 内当前事件序列（含已发生但 renderer 未消费的带 seq 消息），renderer 用其
 *   回放流式历史到 events 通道。
 * - stateSnapshot（wave:remove-bandaids）：4 个 state topic（commands/context/subagents/workflows）
 *   的 last-value 数组，renderer 一次性把当前状态灌入对应 store（替代 selectSession/submitFirstMessage
 *   内的主动拉取 RPC 兜底）。与 snapshot 独立——stateSnapshot 不受 fromSeq 增量过滤影响。
 * - lastSeq：当前 per-session seq 计数器，renderer 记为 lastSeenSeq 做 gap 检测基线。
 * - gap：fromSeq 早于 ring 最旧 seq（旧消息已被 FIFO 淘汰）时 true，renderer 需全量重拉而非增量 backfill。
 *
 * fromSeq：可选，指定起始 seq 回拉（gap 检测触发 reconcile 时传当前缺失的 seq）。
 * 首次订阅不传（runtime 从 ring 末尾开始）。
 *
 * 返回类型由 ReplyPayloadMap['session.subscribe'] 自动推导（payload 消费型）。
 */
export async function subscribe(
  sessionId: string,
  fromSeq?: number,
): Promise<{ snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number; gap?: boolean }> {
  return command('session.subscribe', { sessionId, fromSeq })
}

/**
 * 取消订阅指定 session 的 live 事件流（runtime-message-bus slice）。
 *
 * ack 型（reply message.status，ReplyPayloadMap['session.unsubscribe']=void）。
 * 取消订阅的副作用由后续 live 事件停发体现——renderer 不读 reply payload。
 */
export function unsubscribe(sessionId: string): Promise<void> {
  return command('session.unsubscribe', { sessionId })
}
