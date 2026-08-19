/**
 * SessionScanner W15 磁盘占位值守卫——扫描产出侧测试。
 *
 * 锁定（data-source-governance W15，#2 空串覆盖事故防线）：
 * - scannedToSummary 产出的持久化条目带 source:'scan' 显式标记 + modelId:''/tokenCount:0
 *   占位值（占位语义显式化——合并侧 core mergeViewSnapshot 按 source 分流守卫）；
 * - 活跃实例条目（getActiveSummaries 透传）不标 source（缺省 = owner 权威，D1b 正常覆盖）；
 * - 回归：扫描全量后列表条目数与 sessions 目录 .jsonl 文件数一致（扫描不丢条目），
 *   活跃条目按 filePath 去重（活跃真值优先，扫描副本不进列表）。
 *
 * 真实链路：PiSessionStore.scanSessions（真磁盘，XYZ_AGENT_DATA_DIR 隔离 tmpdir）
 * → SessionScanner.listAll → listPersistedSessions；svc/gitInfoReader 为窄 mock
 * （scanner 只消费 getActiveSummaries/getActiveFilePaths/readGitInfo/pruneStaleCache）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-scanner-source.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionSummary } from '@xyz-agent/shared'
import { SessionScanner } from '../services/session/session-scanner.js'
import { PiSessionStore } from '../infra/pi/session-store.js'
import { invalidateScanDirCache } from '../infra/pi/session-file-utils.js'
import type { ISessionServiceInternal } from '../services/session/session-internal.js'
import type { IGitInfoReader } from '../services/ports/git-info.js'

/** 写一个合法 session JSONL（首行 session header），返回文件绝对路径。 */
function writeSessionFile(sessionsDir: string, sub: string, id: string, cwd: string): string {
  const subDir = join(sessionsDir, sub)
  mkdirSync(subDir, { recursive: true })
  const filePath = join(subDir, `${id}.jsonl`)
  writeFileSync(
    filePath,
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-08-19T00:00:00Z' }) + '\n',
    'utf-8',
  )
  return filePath
}

describe('SessionScanner W15 磁盘占位值来源标记', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'w15-scanner-'))
    process.env.XYZ_AGENT_DATA_DIR = dataDir
    // 目录列举 TTL 缓存跨测试隔离（缓存键含 dir，但显式重置防同 dir 内旧窗口泄漏）
    invalidateScanDirCache()
    sessionsDir = join(dataDir, 'pi', 'sessions')
  })

  afterEach(() => {
    delete process.env.XYZ_AGENT_DATA_DIR
    invalidateScanDirCache()
    rmSync(dataDir, { recursive: true, force: true })
  })

  /** 窄 mock：scanner 只消费 getActiveSummaries / getActiveFilePaths 两个方法。 */
  function makeScanner(active: SessionSummary[], activeFilePaths: Set<string>): SessionScanner {
    const svc = {
      getActiveSummaries: () => active,
      getActiveFilePaths: () => activeFilePaths,
    } as unknown as ISessionServiceInternal
    const gitInfoReader = {
      readGitInfo: () => undefined,
      pruneStaleCache: () => {},
    } as unknown as IGitInfoReader
    return new SessionScanner(svc, new PiSessionStore(), gitInfoReader)
  }

  it('扫描条目带 source:"scan" 标记 + modelId/tokenCount 占位值（W15 占位语义显式化）', () => {
    writeSessionFile(sessionsDir, 'proj-a', 'sess-1', '/work/a')

    const groups = makeScanner([], new Set()).listPersistedSessions()

    expect(groups).toHaveLength(1)
    const scanned = groups[0].sessions[0]
    expect(scanned.id).toBe('sess-1')
    // 占位语义显式化：''/0 不是真值，source:'scan' 让合并侧能按来源分流守卫
    expect(scanned.source).toBe('scan')
    expect(scanned.modelId).toBe('')
    expect(scanned.tokenCount).toBe(0)
  })

  it('活跃实例条目不标 source（缺省 = owner 权威，D1b 正常覆盖路径）', () => {
    writeSessionFile(sessionsDir, 'proj-a', 'sess-1', '/work/a')
    const active: SessionSummary = {
      id: 'sess-live',
      label: '活跃',
      cwd: '/work/a',
      status: 'idle',
      lastActiveAt: 1,
      modelId: 'provider/m-true',
      tokenCount: 77,
    }

    const groups = makeScanner([active], new Set()).listPersistedSessions()

    const all = groups.flatMap((g) => g.sessions)
    const live = all.find((s) => s.id === 'sess-live')
    expect(live?.source).toBeUndefined()
    expect(live?.modelId).toBe('provider/m-true')
    const scanned = all.find((s) => s.id === 'sess-1')
    expect(scanned?.source).toBe('scan')
  })

  it('回归：扫描全量条目数与 sessions 目录 .jsonl 文件数一致（不丢条目；活跃 filePath 去重）', () => {
    writeSessionFile(sessionsDir, 'proj-a', 'f1', '/work/a')
    writeSessionFile(sessionsDir, 'proj-a', 'f2', '/work/a')
    writeSessionFile(sessionsDir, 'proj-b', 'f3', '/work/b')
    writeSessionFile(sessionsDir, 'proj-b', 'f4', '/work/b')
    writeSessionFile(sessionsDir, 'proj-b', 'f5', '/work/b')
    // f5 同文件被活跃实例持有 → 持久化副本去重，活跃真值版本进列表
    const livePath = writeSessionFile(sessionsDir, 'proj-c', 'f6', '/work/c')
    const active: SessionSummary = {
      id: 'f6',
      label: '活跃 f6',
      cwd: '/work/c',
      status: 'active',
      lastActiveAt: 2,
      modelId: 'provider/m-live',
      tokenCount: 9,
      sessionFile: livePath,
    }

    const groups = makeScanner([active], new Set([livePath])).listPersistedSessions()
    const all = groups.flatMap((g) => g.sessions)

    // 目录 6 个文件；f6 活跃去重后总条目数 = 5 个扫描 + 1 个活跃（不重复计入）
    expect(all).toHaveLength(6)
    expect(all.filter((s) => s.source === 'scan')).toHaveLength(5)
    // 活跃去重的 f6 走实例版本（真值 modelId，非扫描占位 ''）
    const f6 = all.find((s) => s.id === 'f6')
    expect(f6?.modelId).toBe('provider/m-live')
    expect(f6?.source).toBeUndefined()
  })
})
