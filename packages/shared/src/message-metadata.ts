import type { Segment } from './segments'

/**
 * SegmentsMetadataFile —— user message 结构化 segments 的 sidecar 存储。
 *
 * 发送 user message 时，xyz-agent 把完整 Segment[]（含 image path/displayName、
 * file path/lineRange 等 pi 边界会丢失的元信息）存到
 * `<dataDir>/attachments/<sessionId>/segments.json`。重开 session 时 runtime 读取此文件，
 * 按 clientUuid（与 pi JSONL 的 xyz.client-msg-id custom entry 映射）回填到对应 user message。
 *
 * 不进 pi JSONL——Segment[] 含磁盘 path、displayName 等 xyz-agent 私有字段，pi 不该承载。
 * 与 pi JSONL 解耦，可独立演进、独立清理。
 */
export interface SegmentsMetadataFile {
  version: 1
  entries: SegmentsMetadataEntry[]
}

export interface SegmentsMetadataEntry {
  /** 客户端 user message UUID（chat store appendUser 生成的 u-<uuid>），主键。 */
  clientUuid: string
  /** 完整结构化 segments（含 image/file/skill/text 等段）。 */
  segments: Segment[]
  /** 发送时间戳（Date.now()，审计/兜底匹配用）。 */
  timestamp: number
}
