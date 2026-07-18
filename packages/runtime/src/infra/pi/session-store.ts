/**
 * ISessionStore 的 infra 实现 —— 封装 pi session 文件操作 + 历史翻译 + 废纸篓。
 *
 * 🔒 归属（R3e1，三层架构）：infra/pi/，实现 services/ports.ts 的 ISessionStore。
 * 聚合 session-file-utils 的 session 函数（scanPiSessions/persistSessionName/
 * patchSessionCwd）+ pi-provider-store 的 refreshAll +
 * message-converter 的 convertPiHistory + system/trash。
 * service 经此 port 访问这些 session 域操作，不直接 import 各 infra 模块。
 */
import type { ISessionStore, ScannedSessionMeta, SessionOutcome } from '../../services/ports/session.js'
import type { Message } from '@xyz-agent/shared'
import {
  scanPiSessions,
  persistSessionName,
  persistSessionEnd,
  extractSessionOutcome,
  patchSessionCwd,
  invalidateSessionMetaCache,
} from './session-file-utils.js'
import { refreshAll } from './pi-provider-store.js'
import { convertPiHistory } from './message-converter.js'
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

  trash(path: string): void {
    trash(path)
  }
}
