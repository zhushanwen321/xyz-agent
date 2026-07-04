/**
 * Composer 域 —— `#` 文件候选 WS 封装（composer 工具区）。
 *
 * real 模式下（VITE_MOCK !== 'true'）由 api/index 注入，替代 mock 静态 fixture。
 *
 * 请求-响应形态（对称 file.ts）：
 * - getFileCandidates → file.search → 'file.search:result' 同步 reply，返回 FileNode[]
 *
 * 依赖方向：transport（send）+ pending（请求-响应配对）。
 * 失败走 error envelope（routeInbound 对 type==='error' 走 pending.reject，code 透传到 Error.code）。
 *
 * 注意：domain 返回原始 FileNode[]（保持真实数据语义）；FileNode → CommandPopover
 * 候选形状（中文 kind / 目录补斜杠）的 DTO 映射在消费侧 lib/file-candidates.ts，
 * 不在 domain 层做（domain 层不应感知 UI 形状）。
 *
 * getMentionCandidates：`@` 候选已废弃（技能走 slash 命令、符号无 LSP），
 * 返回空数组保留签名，避免 CommandPopover 大改。mock 侧仍返回 fixture（mock 模式不受影响）。
 */
import type { FileNode } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'

/**
 * 拉 `#` 文件候选（全量递归当前 cwd，受 ignore + 深度上限 + 结果数上限）。
 * @param sessionId 当前 session（取其 cwd 作为搜索根）
 * @returns FileNode[]（扁平，path 相对 cwd 无前导斜杠）
 */
export function getFileCandidates(sessionId: string): Promise<FileNode[]> {
  const id = pending.create()
  const result = pending.register<{ sessionId: string; files: FileNode[] }>(id)
  transport.send({ type: 'file.search', id, payload: { sessionId } })
  return result.then((r) => r.files)
}

/**
 * `@` 提及候选（已废弃）。技能候选由 slash 命令实现、符号候选无 LSP 能力，
 * 故 real 模式返回空数组。保留签名避免 CommandPopover 调用点改动。
 */
export function getMentionCandidates(): Promise<[]> {
  return Promise.resolve([])
}
