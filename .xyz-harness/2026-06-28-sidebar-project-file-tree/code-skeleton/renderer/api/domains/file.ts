/**
 * code-skeleton/renderer/api/domains/file.ts — file.tree/expand/read WS 封装（⑤code-arch §3，#3/#7）
 *
 * 经 WS client 调用（不直调底层 WS，AC-4）。⑥Wave 接真实 WS 封装范式。
 *
 * 接线层级：[L1-接线] WS 封装。
 *
 * 📌 F-3 protocol reply type：file.tree:result/file.tree.expand:result/file.read:result
 *    需扩 @xyz-agent/shared/protocol.ts ServerMessageType + ServerMessageMap（⑥Wave）。
 */
import type { FileNode } from '@shared/file-tree'

/** WS client 抽象（⑥Wave 接真实 WS 封装，FileView 不直调底层 WS）。 */
export interface WsClient {
  request<T>(type: string, payload: Record<string, unknown>): Promise<T>
}

export function createFileApi(ws: WsClient) {
  return {
    /** file.tree（UC-1）。reply: file.tree:result → FileNode[]。 */
    async tree(sessionId: string, showIgnored?: boolean): Promise<FileNode[]> {
      return ws.request<FileNode[]>('file.tree', { sessionId, showIgnored }) // L1-接线
    },
    /** file.tree.expand（UC-3）。reply: file.tree.expand:result → FileNode[]。 */
    async expand(sessionId: string, path: string, showIgnored?: boolean): Promise<FileNode[]> {
      return ws.request<FileNode[]>('file.tree.expand', { sessionId, path, showIgnored }) // L1-接线
    },
    /** file.read（UC-6 前置，#7）。reply: file.read:result → {content, truncated, path}。 */
    async read(path: string): Promise<{ content: string; truncated: boolean }> {
      return ws.request<{ content: string; truncated: boolean }>('file.read', { path }) // L1-接线
    },
  }
}

export type FileApi = ReturnType<typeof createFileApi>
