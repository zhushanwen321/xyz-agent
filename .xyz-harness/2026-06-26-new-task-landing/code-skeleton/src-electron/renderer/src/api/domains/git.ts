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
 * 提交。message 可选（与 ClientMessageMap 一致；runtime 在空 message 时返回 'commit_message_required' error）。
 * 冲突态 → runtime 返回 'git_conflict' error（domain Promise reject）。
 */
export function commit(sessionId: string, message?: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'git.commit', id, payload: { sessionId, message: message ?? '' } })
  return result
}

/**
 * 切换分支（#6 选分支 popover）。
 *
 * 数据流：useNewTaskFlow.selectBranch/confirmDirtySwitch → checkout(sessionId,name) →
 * transport git.checkout → runtime GitService.checkout → IGitExecutor.exec(checkout,[name])。
 * ack 复用 'message.status' {status:'switched'}，routeInbound 按 msg.id resolve pending。
 *
 * 失败路径（§4.3 E8）：非 git→GitError；分支不存在/dirty 冲突→GitError→本 Promise reject；
 * 超时（port 8000ms）→ reject。失败留 popover 显错（调用方 useNewTaskFlow 处理）。
 */
export function checkout(sessionId: string, name: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'git.checkout', id, payload: { sessionId, name } })
  return result
}

/**
 * 创建并检出分支（#7 创建分支 modal）。
 *
 * 数据流：useNewTaskFlow.submitCreateBranch → createBranch(sessionId,name) →
 * transport git.createBranch → runtime GitService.createBranch → exec(checkout,['-b',name])。
 * ack 复用 'message.status' {status:'branch_created'}。
 *
 * 失败路径（§4.4 E10/E11）：分支名非法/已存在→runtime GitError(code=git_failed)→reject；
 * 超时→reject。调用方留 modal 显错可重试（D-7）。
 */
export function createBranch(sessionId: string, name: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'git.createBranch', id, payload: { sessionId, name } })
  return result
}
