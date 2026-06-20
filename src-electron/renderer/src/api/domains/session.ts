/**
 * Session 域 —— list/create/switchSession。
 *
 * 依赖方向：transport + pending（发送 ClientMessage 并关联 Promise）。
 *
 * 注：方法名用 switchSession 而非 switch（switch 是 TS 保留字）。
 * 注：ServerMessage(id) → pending.resolve 的回灌由 features 层 dispatcher 串联（Wave 3）。
 *      mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { SessionSummary } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'

/** 列出所有 session（mock 返回全字段，D7） */
export function list(): Promise<SessionSummary[]> {
  const id = pending.create()
  const result = pending.register<SessionSummary[]>(id)
  transport.send({ type: 'session.list', id, payload: {} })
  return result
}

/** 创建新 session（可选默认标题） */
export function create(title?: string): Promise<SessionSummary> {
  const id = pending.create()
  const result = pending.register<SessionSummary>(id)
  transport.send({ type: 'session.create', id, payload: { label: title } })
  return result
}

/** 切换到指定 session（id 无效时由 runtime/pending reject） */
export function switchSession(sessionId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'session.switch', id, payload: { sessionId } })
  return result
}
