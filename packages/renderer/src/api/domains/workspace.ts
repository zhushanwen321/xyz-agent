/**
 * Workspace 域 —— 最近工作区记录查询。
 *
 * 依赖方向：transport + pending（发送 ClientMessage 并关联 Promise）。
 *
 * 注：ServerMessage(id) → pending.resolve 的回灌由 features 层 dispatcher 串联（W3）。
 *      mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { RecentWorkspaceRecord } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'

/**
 * 获取最近工作区记录（runtime workspace.listRecent → workspace.recentList reply）。
 *
 * reply payload 形状是 `{ records: RecentWorkspaceRecord[] }`（workspace-message-handler.ts），
 * 解包 `.records` 返 RecentWorkspaceRecord[]。
 */
export async function listRecent(): Promise<RecentWorkspaceRecord[]> {
  const id = pending.create()
  const result = pending.register<{ records: RecentWorkspaceRecord[] }>(id)
  transport.send({ type: 'workspace.listRecent', id, payload: {} })
  return (await result).records
}
