/**
 * ISessionStore 的 infra 实现 —— 封装 pi session 文件操作 + 历史翻译 + 废纸篓。
 *
 * 🔒 归属（R3e1，三层架构）：infra/pi/，实现 services/ports.ts 的 ISessionStore。
 * 聚合 session-file-utils 的 session 函数（scanPiSessions/persistSessionEnd/
 * persistHandoffSidecar 等 sidecar 家族）+ pi-provider-store 的 refreshAll +
 * message-converter 的 convertPiHistory + system/trash。
 * service 经此 port 访问这些 session 域操作，不直接 import 各 infra 模块。
 * [HISTORICAL] persistSessionName / patchSessionCwd 转发已随 W11 删除（绝对写规则：
 * xyz 对 pi session JSONL 的直写归零，分别迁 pi RPC 与 restore tmp 管线）。
 */
import type { ISessionStore, ScannedSessionMeta, SessionOutcome, SessionHeader, RebuiltHistory, ScanSessionsOptions } from '../../services/ports/session.js'
import type { Message, SegmentsMetadataFile } from '@xyz-agent/shared'
import type { PiSessionEntry } from './pi-protocol.js'
import {
  scanPiSessions,
  persistSessionEnd,
  persistPresetBinding,
  persistProjectBinding,
  extractSessionOutcome,
  invalidateSessionMetaCache,
  invalidateScanDirCache,
  parseSessionHeader,
  persistHandoffSidecar,
} from './session-file-utils.js'
import { refreshAll } from './pi-provider-store.js'
import { convertPiHistory } from './message-converter.js'
import { rebuildHistoryFromEntries } from './entry-tree-builder.js'
import { trash } from '../system/trash.js'

export class PiSessionStore implements ISessionStore {
  scanSessions(opts?: ScanSessionsOptions): ScannedSessionMeta[] {
    return scanPiSessions(opts)
  }

  invalidateScanCache(): void {
    invalidateScanDirCache()
  }

  refreshAll(): void {
    refreshAll()
  }

  persistSessionEnd(filePath: string, outcome: SessionOutcome, reason?: string): void {
    persistSessionEnd(filePath, outcome, reason)
  }

  persistPresetBinding(filePath: string, presetId: string): void {
    persistPresetBinding(filePath, presetId)
  }

  persistProjectBinding(filePath: string, projectId: string): void {
    persistProjectBinding(filePath, projectId)
  }

  extractSessionOutcome(filePath: string): SessionOutcome | null {
    return extractSessionOutcome(filePath)
  }

  invalidateMetaCache(filePath: string): void {
    invalidateSessionMetaCache(filePath)
  }

  convertHistory(raw: unknown[], entryIds?: string[]): Message[] {
    // MF5：透传平行 entryIds 给 convertPiHistory，使文件路径产出的 user/assistant message
    // 带 piEntryId（fork 定位用）。entryIds 与 raw 按 index 对齐（mapSessionEntries 产出）。
    return convertPiHistory(raw, entryIds)
  }

  rebuildHistoryFromEntries(entries: unknown[], segmentsMetadata: SegmentsMetadataFile | null): RebuiltHistory {
    // port 入参降级为 unknown[]（不暴露 PiSessionEntry），实现内 cast 回 PiSessionEntry[]
    // 透传 infra 同名函数（TS 编译期类型擦除，运行时无断言开销）。
    return rebuildHistoryFromEntries(entries as PiSessionEntry[], segmentsMetadata)
  }

  parseSessionHeader(filePath: string): SessionHeader | null {
    return parseSessionHeader(filePath)
  }

  persistHandoffSidecar(filePath: string, newSessionId: string): void {
    persistHandoffSidecar(filePath, newSessionId)
  }

  trash(path: string): void {
    trash(path)
  }
}
