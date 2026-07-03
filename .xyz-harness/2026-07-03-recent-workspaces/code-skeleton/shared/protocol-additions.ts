/**
 * shared/protocol.ts 新增条目（4 条映射）。
 *
 * 真实文件 src-electron/shared/src/protocol.ts 改动点（§G code-wiring-cheatsheet）：
 * - ClientMessageType union 末尾加：`| 'workspace.listRecent'`
 * - ClientMessageMap 加：`'workspace.listRecent': Record<string, never>`（请求 payload 空）
 * - ServerMessageType union 加：`| 'workspace.recentList'`
 * - ServerMessageMapBase 加：`'workspace.recentList': { records: RecentWorkspaceRecord[] }`
 *
 * import：`import type { RecentWorkspaceRecord } from './workspace.js'`
 * （DTO 已下沉 workspace.ts，protocol.ts 仅 type→payload 映射，符合 E2 架构候选）
 *
 * reply 路径（D-004 措辞澄清）：经 routeInbound pending map（msg.id 匹配，useConnection.ts:52-72），
 * 不经 events.ts 订阅通道（session/global 通道是 broadcast 专用）。本功能两者都不走。
 *
 * 下面是新增条目 type 声明（骨架验证签名自洽，实现期 merge 到真实 protocol.ts）。
 */
import type { RecentWorkspaceRecord } from './workspace.js'

/** 新增 ClientMessageType 字面量（合并到 ClientMessageType union） */
export type WorkspaceClientMessageType = 'workspace.listRecent'

/** 新增 ClientMessageMap 条目（请求 payload 空） */
export interface WorkspaceClientMessageMap {
  'workspace.listRecent': Record<string, never>
}

/** 新增 ServerMessageType 字面量（合并到 ServerMessageType union） */
export type WorkspaceServerMessageType = 'workspace.recentList'

/** 新增 ServerMessageMapBase 条目（reply payload = records 数组） */
export interface WorkspaceServerMessageMap {
  'workspace.recentList': { records: RecentWorkspaceRecord[] }
}
