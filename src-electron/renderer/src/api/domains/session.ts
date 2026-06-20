/**
 * Session 域 —— list/create/switchSession。
 *
 * 依赖方向：transport + pending（发送 ClientMessage 并关联 Promise）。
 * 骨架阶段：签名完整，体 throw。
 *
 * 注：方法名用 switchSession 而非 switch（switch 是 TS 保留字）。
 */
import type { SessionSummary } from '@xyz-agent/shared'

/** 列出所有 session（mock 返回全字段，D7） */
export function list(): Promise<SessionSummary[]> {
  throw new Error('not implemented')
}

/** 创建新 session（可选默认标题） */
export function create(title?: string): Promise<SessionSummary> {
  throw new Error(`not implemented: create(${title ?? ''})`)
}

/** 切换到指定 session（id 无效时抛） */
export function switchSession(id: string): Promise<void> {
  throw new Error(`not implemented: switchSession(${id})`)
}
