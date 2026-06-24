/**
 * Git 域 —— status/stage/unstage/commit（issues.md #1 / code-architecture §3.1）。
 *
 * 三类形态：
 * - 请求-响应：status（→ 'git.status:result' 同步 reply，经 pending.resolve 消费）
 * - 动作-ack：stage/unstage/commit（→ 'message.status' ack，payload {sessionId, status}）
 *
 * 依赖方向：transport（send）+ pending（请求-响应配对）。不 import events（git 无 server-push 订阅）。
 *
 * 注：stage/unstage/commit 的 ack 复用 'message.status' type（protocol.ts 既有），前端 routeInbound
 * 按 msg.id resolve pending；domain 返回 Promise<void>，忽略 ack payload。失败走 error envelope
 * （routeInbound 对 type==='error' 走 pending.reject），domain Promise 抛出。
 */
import type { GitStatusResult } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'

/** 查询 session cwd 的全量 git 状态（FR-12）。session 不存在 / 非 git 仓库 → isRepo=false 降级结果。 */
export function status(sessionId: string): Promise<GitStatusResult> {
  const id = pending.create()
  const result = pending.register<GitStatusResult>(id)
  transport.send({ type: 'git.status', id, payload: { sessionId } })
  return result
}

/** 暂存文件。空 filePaths → git add -A（全量暂存）。 */
export function stage(sessionId: string, filePaths?: string[]): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'git.stage', id, payload: { sessionId, filePaths } })
  return result
}

/** 取消暂存。空 filePaths → git reset HEAD（全量取消暂存）。 */
export function unstage(sessionId: string, filePaths?: string[]): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'git.unstage', id, payload: { sessionId, filePaths } })
  return result
}

/**
 * 提交。message 必填（runtime 在空 message 时返回 'commit_message_required' error）。
 * 冲突态 → runtime 返回 'git_conflict' error（domain Promise reject）。
 */
export function commit(sessionId: string, message: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'git.commit', id, payload: { sessionId, message } })
  return result
}
