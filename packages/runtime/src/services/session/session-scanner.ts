/**
 * SessionScanner — 从 session-service 巨石拆出的会话列举/分组职责。
 *
 * 负责:listPersistedSessions(对外)+ listGrouped / listAll / pruneGitCache / scannedToSummary。
 *
 * 合并活跃会话(经 Facade 提供的 summaries + filePaths 去重)与
 * 持久化会话(scanPiSessions 读磁盘),按 cwd 分组、按 lastActiveAt 排序。
 *
 * 依赖经构造注入:svc(Facade 内部协议,读取活跃会话数据)。
 */
import { basename } from 'node:path'
import type { SessionSummary, SessionGroup, SessionStatus } from '@xyz-agent/shared'
import type { ISessionServiceInternal } from './session-internal.js'
import type { ISessionStore } from '../ports/session.js'
import type { IGitInfoReader } from '../ports/git-info.js'
import type { ScannedSession } from './types.js'

export class SessionScanner {
  constructor(
    private readonly svc: ISessionServiceInternal,
    private readonly sessionStore: ISessionStore,
    private readonly gitInfoReader: IGitInfoReader,
  ) {}

  listPersistedSessions(): SessionGroup[] {
    return this.listGrouped()
  }

  private listGrouped(): SessionGroup[] {
    const summaries = this.listAll()
    const byCwd: Record<string, SessionSummary[]> = {}
    for (const s of summaries) {
      if (!byCwd[s.cwd]) byCwd[s.cwd] = []
      byCwd[s.cwd].push(s)
    }
    // eslint-disable-next-line taste/no-unsafe-object-entries -- cwd 来自已验证的 SessionSummary,非外部注入
    return Object.entries(byCwd).map(([cwd, sessions]) => ({ cwd, sessions }))
  }

  private listAll(): SessionSummary[] {
    const active = this.svc.getActiveSummaries()
    const activeFilePaths = this.svc.getActiveFilePaths()

    const persisted = this.sessionStore.scanSessions()
      .filter(s => !activeFilePaths.has(s.filePath))
      .map(s => this.scannedToSummary(s))

    const result = [...active, ...persisted]
      // 隐藏 session（公共 session）不进 sidebar 列表。active（内存 Map，hidden 标记在
      // IManagedSessionView）和 persisted（磁盘扫描，hidden 标记经 toSummary 透传）都过滤。
      .filter(s => !s.hidden)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    this.pruneGitCache(result)
    return result
  }

  /** Prune git-info cache entries for cwds no longer represented in any session. */
  private pruneGitCache(allSummaries: SessionSummary[]): void {
    const cwds = new Set(allSummaries.map(s => s.cwd))
    this.gitInfoReader.pruneStaleCache(cwds)
  }

  private scannedToSummary(s: ScannedSession): SessionSummary {
    const git = this.gitInfoReader.readGitInfo(s.cwd)
    // W5：读 session_end 终态（ADR 0036）。无 entry（历史 session / 未结束）→ idle 兜底
    const outcome = this.sessionStore.extractSessionOutcome(s.filePath)
    return {
      id: s.id,
      label: s.name ?? basename(s.cwd),
      cwd: s.cwd,
      gitBranch: git?.branch,
      gitIsWorktree: git?.isWorktree,
      status: (outcome ?? 'idle') as SessionStatus,
      lastActiveAt: s.lastModified,
      modelId: '',
      tokenCount: 0,
      sessionFile: s.filePath,
    }
  }
}
