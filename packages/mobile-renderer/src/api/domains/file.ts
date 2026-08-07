/**
 * File 域 —— file.tree/expand/read WS 封装（issues.md #3 / code-architecture §3.8）。
 *
 * 请求-响应形态（对称 git.ts）：
 * - file.tree → 'file.tree:result' 同步 reply
 * - file.tree.expand → 'file.tree.expand:result' 同步 reply
 * - file.read → 'file.read:result' 同步 reply
 *
 * 依赖方向：command（类型化原语，统一 pending.create + register + transport.send）。不 import events（file 无 server-push 订阅）。
 * 失败走 error envelope（routeInbound 对 type==='error' 走 pending.reject，code 透传到 Error.code）。
 */
import type { FileNode } from '@xyz-agent/shared'
import { command } from '../request'

/**
 * 文件树首加载（UC-1）。返回顶层 + 一级子 FileNode[]。
 * ignored 节点始终返回并标 ignored=true，前端按 showIgnored 开关本地过滤。
 */
export async function tree(sessionId: string): Promise<FileNode[]> {
  const reply = await command('file.tree', { sessionId })
  return reply.tree
}

/**
 * 展开目录单层子（UC-3）。
 * @param path 相对 cwd 的目录路径（如 'src/utils'）
 */
export async function expand(sessionId: string, path: string): Promise<FileNode[]> {
  const reply = await command('file.tree.expand', { sessionId, path })
  return reply.children
}

/**
 * 读文件内容（UC-6 前置）。
 * - 有 sessionId：走 cwd 守门（readFile(sessionId, path)），用于文件树预览 session cwd 内文件（#7 BC-3 扩展）
 * - 无 sessionId：走 BC-3 三目录白名单（skill 文件预览，向后兼容）
 * @param path 文件路径（有 sessionId 时相对 cwd，无 sessionId 时为白名单目录内绝对路径）
 * @param sessionId 可选，文件树预览时传入
 */
export async function read(
  path: string,
  sessionId?: string,
): Promise<{ content: string; truncated: boolean }> {
  const payload: { path: string; sessionId?: string } = { path }
  if (sessionId !== undefined) payload.sessionId = sessionId
  const reply = await command('file.read', payload)
  return { content: reply.content, truncated: reply.truncated }
}

/**
 * 请求临时可访问的文件签名 URL（远程模式 DetailPane 图片用，spec §十 D8）。
 *
 * 行为：
 * - 调 RPC `file.signUrl`（P0 §5 已实施），runtime 返相对 URL `/file?path=...&sig=...&expires=...`
 *   + expiresAt（ms）。调用方拼 httpOrigin（wsUrlToHttpOrigin(wsUrl)）后为完整可访问 URL。
 * - TTL 5 分钟不缓存：每次打开预览现签（P0 §5.1 语义）；`<img>` 自身 HTTP cache
 *   （`Cache-Control: private, max-age=300`）兜底重复访问。
 * - 无 sessionId（file.signUrl 无 session 语义，签名 URL 自带白名单守门）。
 * - 失败走 error envelope（routeInbound 透传 code 到 Error.code），调用方 try/catch 降级。
 *
 * @param path 文件绝对路径（cwd + 相对路径 resolve 后，runtime realpath 校验白名单）
 * @returns { url: 相对形式 '/file?...'; expiresAt: 过期 ms 时间戳 }
 */
export async function signUrl(
  path: string,
): Promise<{ url: string; expiresAt: number }> {
  const reply = await command('file.signUrl', { path })
  return { url: reply.url, expiresAt: reply.expiresAt }
}
