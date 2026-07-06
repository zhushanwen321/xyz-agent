/**
 * Session 域 —— list/create/switchSession。
 *
 * 依赖方向：transport + pending（发送 ClientMessage 并关联 Promise）。
 *
 * 注：方法名用 switchSession 而非 switch（switch 是 TS 保留字）。
 * 注：ServerMessage(id) → pending.resolve 的回灌由 features 层 dispatcher 串联（Wave 3）。
 *      mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'

/**
 * 列出所有 session，按 cwd 分组（对齐后端 SessionGroup[]，D7）。
 *
 * runtime 的 session.list reply payload 形状是 `{ groups: SessionGroup[] }`
 * （session-message-handler.ts / server.ts:224 sendInitialState 同形）。
 * useConnection 的 pending.resolve(msg.id, msg.payload) 把整个 payload 回灌，
 * 故此处收到 `{ groups: [...] }`，需解包 `.groups` 返 `SessionGroup[]`。
 */
export async function list(): Promise<SessionGroup[]> {
  const id = pending.create()
  const result = pending.register<{ groups: SessionGroup[] }>(id)
  transport.send({ type: 'session.list', id, payload: {} })
  return (await result).groups
}

/**
 * 创建新 session（#1 cwd 透传，位置参数 create(cwd?, label?)，issues #1 方案 A）。
 *
 * 边界：cwd=undefined → payload 不含 cwd 键（runtime 回退 process.cwd()，AC-1.2 回归）；
 * 非法 cwd → runtime reject → 本 Promise reject（§4.1 E2）。runtime session.create handler
 * 负责 cwd 校验 + pi spawn，失败回滚 session 实体不留僵尸（NFR④#1）。
 * runtime session.created reply envelope 是 `{ session }`（session-message-handler.ts），解包 `.session`。
 */
export async function create(cwd?: string, label?: string): Promise<SessionSummary> {
  const id = pending.create()
  const result = pending.register<{ session: SessionSummary }>(id)
  // cwd/label 为 undefined 时不写入 payload 键（AC-1.1/1.2），让 runtime 回退默认
  const payload: { cwd?: string; label?: string } = {}
  if (cwd !== undefined) payload.cwd = cwd
  if (label !== undefined) payload.label = label
  transport.send({ type: 'session.create', id, payload })
  return (await result).session
}

/** 切换到指定 session（id 无效时由 runtime/pending reject） */
export function switchSession(sessionId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'session.switch', id, payload: { sessionId } })
  return result
}

/**
 * 拉取 session 的扩展命令（pi getCommands）。
 * 修复 broadcast 与订阅时序竞争：session.switch 的 ensureActive 内部 broadcast commands
 * 发生在 renderer 订阅建立之前会被丢弃；renderer 切 session 后主动调本方法拉取。
 * reply type 为 session.commands，payload 是 { sessionId, commands }，调用方负责本地 dispatch。
 */
export function getCommands(sessionId: string): Promise<{ sessionId: string; commands: Array<{ name: string; description?: string; source: string }> }> {
  const id = pending.create()
  const result = pending.register<{ sessionId: string; commands: Array<{ name: string; description?: string; source: string }> }>(id)
  transport.send({ type: 'session.getCommands', id, payload: { sessionId } })
  return result
}

/**
 * 拉取 session 的当前上下文用量（pi get_session_stats.contextUsage）。
 * 修复 broadcast 与订阅时序竞争：restoreSession 内部的兜底 broadcast 早于前端订阅新 sessionId 通道，
 * renderer 切 session 后主动调本方法拉取，reply context.update payload，调用方本地 dispatch 投递。
 */
export function getContext(sessionId: string): Promise<{ sessionId: string; inputTokens: number; contextLimit: number; usagePercent: number }> {
  const id = pending.create()
  const result = pending.register<{ sessionId: string; inputTokens: number; contextLimit: number; usagePercent: number }>(id)
  transport.send({ type: 'session.getContext', id, payload: { sessionId } })
  return result
}

/** 重命名 session（label 更新） */
export function rename(sessionId: string, label: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'session.rename', id, payload: { sessionId, name: label } })
  return result
}

/** 删除 session（从列表移除） */
export function remove(sessionId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'session.delete', id, payload: { sessionId } })
  return result
}

/**
 * 设置 session 的思考等级（动作；确认由 session.thinkingLevelSet reply 回灌 pending）。
 * level 是前端 6 级枚举字符串（off/low/medium/high/xhigh/max，见 thinking-levels.ts）。
 */
export function setThinkingLevel(sessionId: string, level: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'session.setThinkingLevel', id, payload: { sessionId, level } })
  return result
}
