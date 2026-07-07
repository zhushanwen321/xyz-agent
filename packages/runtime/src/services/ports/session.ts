/**
 * Session 域 ports —— pi session 文件的发现/扫描/持久化 + 历史翻译。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/session-store.ts 实现。
 * 封装 session-file-utils 的 session 相关函数 + message-converter 的 convertPiHistory
 * + system/trash。session 域的 pi 文件/状态操作，service 经此 port 访问。
 */

/** scanPiSessions 返回的 session 元信息（持久化会话扫描结果）。 */
export interface ScannedSessionMeta {
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  lastModified: number
  size: number
}

/**
 * session 存储 port。service 经此 port 访问，不直接 import infra。
 */
export interface ISessionStore {
  /** 扫描 pi sessions 目录，返回持久化会话列表。 */
  scanSessions(): ScannedSessionMeta[]
  /** 刷新 pi 配置缓存（models + settings 全量重读）。 */
  refreshAll(): void
  /** 持久化 session 名称。 */
  persistSessionName(filePath: string, name: string, id?: string, cwd?: string): void
  /** 修正 session 文件的 cwd 字段。 */
  patchSessionCwd(filePath: string, newCwd: string): boolean
  /** 翻译 pi 历史（unknown[] → Message[]）。pi 结构只在此实现内部断言。 */
  convertHistory(raw: unknown[]): import('@xyz-agent/shared').Message[]
  /** 删除文件/目录到废纸篓（session 资源清理）。 */
  trash(path: string): void
}
