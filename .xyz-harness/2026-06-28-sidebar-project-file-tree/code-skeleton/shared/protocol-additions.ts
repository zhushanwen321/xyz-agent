/**
 * code-skeleton/shared/protocol-additions.ts — file.tree/git.diff/file.write 消息类型扩展（⑤code-arch §3 F-3，#1/#5/#14）
 *
 * 📌 骨架验证契约：实证 @xyz-agent/shared/protocol.ts:221-222 当前 ServerMessageType 仅有
 * file.read:result/git.status:result，缺 file.tree:result/file.tree.expand:result/git.diff:result。
 * 本文件定义新增消息类型（⑥Wave 合并进 protocol.ts 时按此契约）。
 *
 * ClientMessageType 扩展（#1/#5/#14）：
 *   file.tree / file.tree.expand / file.read（已有）/ git.diff / file.write.create/rename/delete
 * ServerMessageType 扩展（reply）：
 *   file.tree:result / file.tree.expand:result / file.read:result（已有）/ git.diff:result / file.write.*:result
 */
import type { FileNode } from './file-tree'

/** file.tree 请求参数（#3，含 showIgnored 双模式 D-020）。 */
export interface FileTreePayload {
  sessionId: string
  /** 显示被 .gitignore 匹配的节点（默认 false 隐藏，D-004/D-020）。 */
  showIgnored?: boolean
}

/** file.tree.expand 请求参数（#3，展开指定目录单层子）。 */
export interface FileTreeExpandPayload extends FileTreePayload {
  path: string
}

/** file.read 请求参数（#7，已有，此处复述契约）。 */
export interface FileReadPayload {
  path: string
}

/** file.read:result 返回（#7，含截断标志 AC-6.7）。 */
export interface FileReadResult {
  content: string
  truncated: boolean
  path: string
}

/** git.diff 请求参数（#5）。 */
export interface GitDiffPayload {
  sessionId: string
  path: string
}

/** git.diff:result 返回（#5，含 binary 标志 AC-5.5）。 */
export interface GitDiffResult {
  patch: string
  binary: boolean
}

/** file.write.* 请求参数骨架（#14，G4 实现延后）。 */
export interface FileWriteCreatePayload {
  sessionId: string
  path: string
  content?: string
}
export interface FileWriteRenamePayload {
  sessionId: string
  from: string
  to: string
}
export interface FileWriteDeletePayload {
  sessionId: string
  path: string
}

/** file.write.*:result 骨架响应（AC-14.4：结构化「待 G4 实现」，非 500）。 */
export interface FileWriteResult {
  ok: boolean
  /** 骨架阶段恒 'not_implemented'（G4 实现后改真实结果）。 */
  reason?: 'not_implemented'
}

// ServerMessageMap 扩展（reply type 闭环，F-3）：
// 'file.tree:result' → FileNode[]
// 'file.tree.expand:result' → FileNode[]
// 'file.read:result' → FileReadResult（已有，扩展 truncated）
// 'git.diff:result' → GitDiffResult
// 'file.write.*:result' → FileWriteResult
export type FileTreeServerResults = {
  'file.tree:result': FileNode[]
  'file.tree.expand:result': FileNode[]
  'file.read:result': FileReadResult
  'git.diff:result': GitDiffResult
  'file.write.create:result': FileWriteResult
  'file.write.rename:result': FileWriteResult
  'file.write.delete:result': FileWriteResult
}
