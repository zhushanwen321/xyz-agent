/**
 * Session 域 ports —— pi session 文件的发现/扫描/持久化 + 历史翻译。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/session-store.ts 实现。
 * 封装 session-file-utils 的 session 相关函数 + message-converter 的 convertPiHistory
 * + system/trash。session 域的 pi 文件/状态操作，service 经此 port 访问。
 */

import type { Message, SegmentsMetadataFile } from '@xyz-agent/shared'

/** scanPiSessions 返回的 session 元信息（持久化会话扫描结果）。 */
export interface ScannedSessionMeta {
  id: string
  filePath: string
  cwd: string
  timestamp: string
  name: string | null
  lastModified: number
  size: number
  /** session 终态（W4，ADR 0042）；无 session_end entry（历史/未结束）→ null。 */
  outcome: SessionOutcome | null
  /** 父 session 血缘键（FR-3，与 infra/pi/session-file-utils 版本对齐）。 */
  parentSession?: string
  /** fork 锚点 entry id（FR-3，与 infra/pi/session-file-utils 版本对齐）。 */
  forkEntryId?: string
  /** handoff 目标 session id（FR-5，与 infra/pi/session-file-utils 版本对齐）。 */
  handedOffTo?: string
  /** launch preset 绑定（从 .preset.json sidecar 读，与 infra/pi/session-file-utils 版本对齐）。 */
  launchPresetId?: string
  /** 归属 project id（从 .project.json sidecar 读，D14 语义修正 2026-08-04）。 */
  projectId?: string
}

/** session 终态类型（W4，ADR 0042）。与 infra/pi/session-file-utils 的 SessionOutcome 结构对齐。 */
export type SessionOutcome = 'done' | 'error' | 'stopped'

/**
 * session .jsonl 首行 header entry（type=session）解析结果。
 *
 * 纯数据类型（全 string 字段），从 infra/pi/session-file-utils.ts 提升到 port：
 * parseSessionHeader 收口到 port 后其返回类型必须 port 可见。
 * infra 原 SessionHeader 与之结构兼容（TS 结构类型，infra 侧无需改 import 源
 * 即可被 PiSessionStore 委托返回）。
 */
export interface SessionHeader {
  id: string
  cwd: string
  timestamp: string
  /** 父 session 血缘键（fork 出的 session header 指回源文件/源 sessionId）。 */
  parentSession?: string
  /** fork 锚点 entry id（截断点）。 */
  forkEntryId?: string
}

/**
 * entry 树重建历史结果。
 *
 * 纯数据类型（Message[] + Map），从 infra/pi/entry-tree-builder.ts 提升到 port：
 * rebuildHistoryFromEntries 收口到 port 后其返回类型必须 port 可见。
 * 保留 clientUuidMap（userEntryId→clientUuid 映射）——未来增量拉取
 * （getEntries(since=leafId)）/ branch 完整性判断需用，收口不降级原函数能力。
 */
export interface RebuiltHistory {
  messages: Message[]
  /** userEntryId → clientUuid 映射（来自 "xyz.client-msg-id" custom entry）。 */
  clientUuidMap: Map<string, string>
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
  /** 持久化 session 终态（W4，ADR 0042）。 */
  persistSessionEnd(filePath: string, outcome: SessionOutcome, reason?: string): void
  /** 持久化 launch preset 绑定到 .preset.json sidecar（设计文档 §4）。 */
  persistPresetBinding(filePath: string, presetId: string): void
  /** 持久化归属 project 到 .project.json sidecar（D14 语义修正，2026-08-04）。 */
  persistProjectBinding(filePath: string, projectId: string): void
  /** 读取 session 终态（W5）；无 session_end entry 返回 null（历史 session）。 */
  extractSessionOutcome(filePath: string): SessionOutcome | null
  /** 清除 session 元信息缓存的 stale 条目（session 删除/重命名后调用，避免无界增长）。 */
  invalidateMetaCache(filePath: string): void
  /** 修正 session 文件的 cwd 字段。 */
  patchSessionCwd(filePath: string, newCwd: string): boolean
  /** 翻译 pi 历史（unknown[] → Message[]）。pi 结构只在此实现内部断言。 */
  convertHistory(raw: unknown[]): import('@xyz-agent/shared').Message[]
  /**
   * 从 pi get_entries 返回的 entry 树重建 xyz-agent Message[]。
   *
   * entries 降级为 unknown[]（port 不暴露 PiSessionEntry，PiSessionStore 实现内
   * cast 回 PiSessionEntry[]，与 convertHistory 处理 unknown[] 同模式）。
   * segmentsMetadata 为 segments.json sidecar（null=无 sidecar，全降级为占位文本，
   * 非硬错误）。返回 RebuiltHistory{messages, clientUuidMap}。
   */
  rebuildHistoryFromEntries(entries: unknown[], segmentsMetadata: SegmentsMetadataFile | null): RebuiltHistory
  /**
   * 解析 session .jsonl 首行（type=session 的 header entry）。
   *
   * 首行非 session 类型 / 文件不存在 / JSON.parse 失败 → catch 返回 null（不抛）。
   */
  parseSessionHeader(filePath: string): SessionHeader | null
  /**
   * 向源 session JSONL 追加 handoff_marker entry（供 scanner 尾读提取 handedOffTo）。
   *
   * filePath 为空 / 文件不存在（pi 延迟写入窗口，规则 #6）→ console.warn + 静默跳过
   * （绝不创建文件，与 pi 0.80.3 _persist openSync('wx') 竞态防护）。写失败 catch→
   * console.error 不抛。
   */
  persistHandedOff(filePath: string, newSessionId: string): void
  /** 删除文件/目录到废纸篓（session 资源清理）。 */
  trash(path: string): void
}
