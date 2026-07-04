/**
 * File 域 —— file.tree/expand/read WS 封装（issues.md #3 / code-architecture §3.8）。
 *
 * 请求-响应形态（对称 git.ts）：
 * - file.tree → 'file.tree:result' 同步 reply
 * - file.tree.expand → 'file.tree.expand:result' 同步 reply
 * - file.read → 'file.read:result' 同步 reply
 *
 * 依赖方向：transport（send）+ pending（请求-响应配对）。不 import events（file 无 server-push 订阅）。
 * 失败走 error envelope（routeInbound 对 type==='error' 走 pending.reject，code 透传到 Error.code）。
 */
import type { FileNode } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'

/**
 * 文件树首加载（UC-1）。返回顶层 + 一级子 FileNode[]。
 * ignored 节点始终返回并标 ignored=true，前端按 showIgnored 开关本地过滤。
 */
export function tree(sessionId: string): Promise<FileNode[]> {
  const id = pending.create()
  const result = pending.register<{ sessionId: string; tree: FileNode[] }>(id)
  transport.send({ type: 'file.tree', id, payload: { sessionId } })
  return result.then((r) => r.tree)
}

/**
 * 展开目录单层子（UC-3）。
 * @param path 相对 cwd 的目录路径（如 'src/utils'）
 */
export function expand(sessionId: string, path: string): Promise<FileNode[]> {
  const id = pending.create()
  const result = pending.register<{ sessionId: string; children: FileNode[] }>(id)
  transport.send({ type: 'file.tree.expand', id, payload: { sessionId, path } })
  return result.then((r) => r.children)
}

/**
 * 读文件内容（UC-6 前置）。
 * - 有 sessionId：走 cwd 守门（readFile(sessionId, path)），用于文件树预览 session cwd 内文件（#7 BC-3 扩展）
 * - 无 sessionId：走 BC-3 三目录白名单（skill 文件预览，向后兼容）
 * @param path 文件路径（有 sessionId 时相对 cwd，无 sessionId 时为白名单目录内绝对路径）
 * @param sessionId 可选，文件树预览时传入
 */
export function read(path: string, sessionId?: string): Promise<{ content: string; truncated: boolean }> {
  const id = pending.create()
  const result = pending.register<{ content: string; truncated: boolean; path: string }>(id)
  transport.send({ type: 'file.read', id, payload: sessionId ? { path, sessionId } : { path } })
  return result.then((r) => ({ content: r.content, truncated: r.truncated }))
}
