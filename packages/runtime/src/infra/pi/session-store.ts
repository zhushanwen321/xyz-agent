/**
 * ISessionStore 的 infra 实现 —— 封装 pi session 文件操作 + 历史翻译 + 废纸篓。
 *
 * 🔒 归属（R3e1，三层架构）：infra/pi/，实现 services/ports.ts 的 ISessionStore。
 * 聚合 session-file-utils 的 session 函数（scanPiSessions/persistSessionName/
 * patchSessionCwd）+ pi-provider-store 的 refreshAll +
 * message-converter 的 convertPiHistory + system/trash。
 * service 经此 port 访问这些 session 域操作，不直接 import 各 infra 模块。
 */
import type { ISessionStore, ScannedSessionMeta, SessionOutcome, SessionHeader, RebuiltHistory } from '../../services/ports/session.js'
import type { Message, SegmentsMetadataFile } from '@xyz-agent/shared'
import type { PiSessionEntry } from './pi-protocol.js'
import {
  scanPiSessions,
  persistSessionName,
  persistSessionEnd,
  persistPresetBinding,
  extractSessionOutcome,
  patchSessionCwd,
  invalidateSessionMetaCache,
  parseSessionHeader,
  persistHandedOff,
} from './session-file-utils.js'
import { refreshAll } from './pi-provider-store.js'
import { convertPiHistory } from './message-converter.js'
import { rebuildHistoryFromEntries } from './entry-tree-builder.js'
import { trash } from '../system/trash.js'

export class PiSessionStore implements ISessionStore {
  scanSessions(): ScannedSessionMeta[] {
    return scanPiSessions()
  }

  refreshAll(): void {
    refreshAll()
  }

  persistSessionName(filePath: string, name: string, id?: string, cwd?: string): void {
    persistSessionName(filePath, name, id, cwd)
  }

  persistSessionEnd(filePath: string, outcome: SessionOutcome, reason?: string): void {
    persistSessionEnd(filePath, outcome, reason)
  }

  persistPresetBinding(filePath: string, presetId: string): void {
    persistPresetBinding(filePath, presetId)
  }

  extractSessionOutcome(filePath: string): SessionOutcome | null {
    return extractSessionOutcome(filePath)
  }

  invalidateMetaCache(filePath: string): void {
    invalidateSessionMetaCache(filePath)
  }

  patchSessionCwd(filePath: string, newCwd: string): boolean {
    return patchSessionCwd(filePath, newCwd)
  }

  convertHistory(raw: unknown[]): Message[] {
    return convertPiHistory(raw)
  }

  rebuildHistoryFromEntries(entries: unknown[], segmentsMetadata: SegmentsMetadataFile | null): RebuiltHistory {
    // port 入参降级为 unknown[]（不暴露 PiSessionEntry），实现内 cast 回 PiSessionEntry[]
    // 透传 infra 同名函数（TS 编译期类型擦除，运行时无断言开销）。
    return rebuildHistoryFromEntries(entries as PiSessionEntry[], segmentsMetadata)
  }

  parseSessionHeader(filePath: string): SessionHeader | null {
    return parseSessionHeader(filePath)
  }

  persistHandedOff(filePath: string, newSessionId: string): void {
    persistHandedOff(filePath, newSessionId)
  }

  trash(path: string): void {
    trash(path)
  }
}
