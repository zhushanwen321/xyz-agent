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

/** 创建新 session（可选默认标题）。
 *  runtime session.created reply envelope 是 `{ session }`（session-message-handler.ts:39），
 *  与 list() 解包 `.groups` 同理，此处解包 `.session` 返 SessionSummary。 */
export async function create(title?: string): Promise<SessionSummary> {
  const id = pending.create()
  const result = pending.register<{ session: SessionSummary }>(id)
  transport.send({ type: 'session.create', id, payload: { label: title } })
  return (await result).session
}

/** 切换到指定 session（id 无效时由 runtime/pending reject） */
export function switchSession(sessionId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'session.switch', id, payload: { sessionId } })
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
