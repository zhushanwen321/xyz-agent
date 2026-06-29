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
 * @param showIgnored true 时 ignored 节点保留并标 ignored=true（D-020）
 */
export function tree(sessionId: string, showIgnored?: boolean): Promise<FileNode[]> {
  const id = pending.create()
  const result = pending.register<{ sessionId: string; tree: FileNode[] }>(id)
  transport.send({ type: 'file.tree', id, payload: { sessionId, showIgnored } })
  return result.then((r) => r.tree)
}

/**
 * 展开目录单层子（UC-3）。
 * @param path 相对 cwd 的目录路径（如 'src/utils'）
 */
export function expand(sessionId: string, path: string, showIgnored?: boolean): Promise<FileNode[]> {
  const id = pending.create()
  const result = pending.register<{ sessionId: string; children: FileNode[] }>(id)
  transport.send({ type: 'file.tree.expand', id, payload: { sessionId, path, showIgnored } })
  return result.then((r) => r.children)
}

/**
 * 读文件内容（UC-6 前置，走 BC-3 白名单）。
 * @param path 绝对路径（白名单目录内）
 */
export function read(path: string): Promise<{ content: string; truncated: boolean }> {
  const id = pending.create()
  const result = pending.register<{ content: string; truncated: boolean; path: string }>(id)
  transport.send({ type: 'file.read', id, payload: { path } })
  return result.then((r) => ({ content: r.content, truncated: r.truncated }))
}
