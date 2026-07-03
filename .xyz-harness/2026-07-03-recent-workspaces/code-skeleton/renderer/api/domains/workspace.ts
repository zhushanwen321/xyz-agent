/**
 * workspace 域 API client（#4，模板 api/domains/session.ts:list）。
 *
 * pending pattern（D-004 pull RPC reply 经 routeInbound pending map，msg.id 匹配）：
 * pending.create() → register<T>(id) → transport.send → [WS round-trip] → reply(msg.id) → pending.resolve
 *
 * 依赖方向：transport + pending（发送 ClientMessage 并关联 Promise）。
 * 不直接 import store（domain 门面只调 transport+pending，编排跨 store 归 composable——ADR-0028）。
 */
import type { RecentWorkspaceRecord } from '../../../shared/workspace.js'
import { pending, transport } from '../../../_deps.js'

/**
 * 拉取最近工作区列表（≤10 倒序）。
 * runtime 的 workspace.recentList reply payload 是 { records: RecentWorkspaceRecord[] }，
 * pending.register 回灌整个 payload，解包 .records 返回。
 *
 * 边界：RPC reject（transport 断/超时）→ Promise reject，调用方（workspaceStore.load）catch 降级（AC-4.5）。
 */
export async function listRecent(): Promise<RecentWorkspaceRecord[]> {
  const id = pending.create()
  const result = pending.register<{ records: RecentWorkspaceRecord[] }>(id)
  transport.send({ type: 'workspace.listRecent', id, payload: {} })
  return (await result).records
}
