/**
 * Session 域 —— list/create/switchSession。
 *
 * 依赖方向：transport + pending（经 request helper 统一发送 ClientMessage 并关联 Promise）。
 *
 * 注：方法名用 switchSession 而非 switch（switch 是 TS 保留字）。
 * 注：ServerMessage(id) → pending.resolve 的回灌由 features 层 dispatcher 串联（Wave 3）。
 *      mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { SessionSummary, SessionGroup, SubagentRecord, WorkflowRunRecord, Message } from '@xyz-agent/shared'
import { request } from '../request'

/**
 * 列出所有 session，按 cwd 分组（对齐后端 SessionGroup[]，D7）。
 * reply payload 是 { groups: SessionGroup[] }，解包 .groups。
 */
export async function list(): Promise<SessionGroup[]> {
  const reply = await request<{ groups: SessionGroup[] }>('session.list')
  return reply.groups
}

/**
 * 创建新 session（#1 cwd 透传，位置参数 create(cwd?, label?)，issues #1 方案 A）。
 * cwd=undefined → payload 不含 cwd 键（runtime 回退 process.cwd()，AC-1.2 回归）。
 * reply envelope 是 { session }，解包 .session。
 */
export async function create(cwd?: string, label?: string): Promise<SessionSummary> {
  const payload: { cwd?: string; label?: string } = {}
  if (cwd !== undefined) payload.cwd = cwd
  if (label !== undefined) payload.label = label
  const reply = await request<{ session: SessionSummary }>('session.create', payload)
  return reply.session
}

/** 切换到指定 session（id 无效时由 runtime/pending reject） */
export function switchSession(sessionId: string): Promise<void> {
  return request<void>('session.switch', { sessionId })
}

/**
 * Fork session：从 srcSessionId 截断到 fromPiEntryId，创建新 session（独立 pi 进程）。
 * reply 复用 session.created，解包 .session。
 */
export async function fork(
  srcSessionId: string,
  fromPiEntryId: string,
  opts?: { includeFrom?: boolean; label?: string },
): Promise<SessionSummary> {
  const reply = await request<{ session: SessionSummary }>('session.fork', {
    srcSessionId,
    fromPiEntryId,
    ...opts,
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
  return request<{ sessionId: string; commands: Array<{ name: string; description?: string; source: string }> }>(
    'session.getCommands',
    { sessionId },
  )
}

/**
 * 拉取 session 的当前上下文用量（pi get_session_stats.contextUsage）。
 * 修复 broadcast 与订阅时序竞争：restoreSession 内部兜底 broadcast 早于前端订阅，renderer 主动拉取。
 */
export function getContext(
  sessionId: string,
): Promise<{ sessionId: string; inputTokens: number; contextLimit: number; usagePercent: number }> {
  return request<{ sessionId: string; inputTokens: number; contextLimit: number; usagePercent: number }>(
    'session.getContext',
    { sessionId },
  )
}

/** 重命名 session（label 更新） */
export function rename(sessionId: string, label: string): Promise<void> {
  return request<void>('session.rename', { sessionId, name: label })
}

/** 删除 session（从列表移除） */
export function remove(sessionId: string): Promise<void> {
  return request<void>('session.delete', { sessionId })
}

/**
 * 设置 session 的思考等级（动作；确认由 session.thinkingLevelSet reply 回灌 pending）。
 * level 是前端 6 级枚举字符串（off/low/medium/high/xhigh/max，见 thinking-levels.ts）。
 */
export function setThinkingLevel(sessionId: string, level: string): Promise<void> {
  return request<void>('session.setThinkingLevel', { sessionId, level })
}

/**
 * 获取 session 派生的 subagent 列表（runtime 从主 session JSONL 提取）。
 * reply payload 是 { sessionId, subagents }，解包 .subagents。
 */
export async function getSubagents(sessionId: string): Promise<SubagentRecord[]> {
  const reply = await request<{ subagents: SubagentRecord[] }>('session.getSubagents', { sessionId })
  return reply.subagents
}

/**
 * 获取 subagent 的对话流历史（runtime 直读 subagent JSONL）。
 * reply payload 是 { sessionId, subagentId, messages }，解包 .messages。
 */
export async function getSubagentHistory(sessionId: string, subagentId: string): Promise<Message[]> {
  const reply = await request<{ messages: Message[] }>('session.getSubagentHistory', { sessionId, subagentId })
  return reply.messages
}

/**
 * 获取 session 派生的 workflow 列表（runtime 从主 session JSONL 的 workflow-state-link 提取）。
 * reply payload 是 { sessionId, workflows }，解包 .workflows。
 */
export async function getWorkflows(sessionId: string): Promise<WorkflowRunRecord[]> {
  const reply = await request<{ workflows: WorkflowRunRecord[] }>('session.getWorkflows', { sessionId })
  return reply.workflows
}

/**
 * 获取 workflow 内 agent call 的对话流历史（runtime 按 trace[].sessionId 查找 JSONL）。
 * reply payload 是 { sessionId, agentCallSessionId, messages }，解包 .messages。
 */
export async function getAgentCallHistory(sessionId: string, agentCallSessionId: string): Promise<Message[]> {
  const reply = await request<{ messages: Message[] }>('session.getAgentCallHistory', { sessionId, agentCallSessionId })
  return reply.messages
}

/**
 * 解析 agent call 对话流 JSONL 绝对路径（PanelHeader overlay 文件名展示用）。
 * runtime 按 trace[].sessionId 在 subagents 目录查找，找不到返回空串（展示型功能不 throw）。
 */
export async function getAgentCallFilePath(sessionId: string, agentCallSessionId: string): Promise<string> {
  const reply = await request<{ filePath: string }>('session.getAgentCallFilePath', { sessionId, agentCallSessionId })
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
  return request<void>('session.workflowAction', { sessionId, action, runId })
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
  return request<void>('session.subagentAction', { sessionId, action, subagentId })
}
