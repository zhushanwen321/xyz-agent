/**
 * GitStateService —— IGitStateService 的实现（03-git-state-service D4-2/D4-3，perf W16）。
 *
 * 三个机制（对应设计目标「重复执行消除」+「写操作后即时」）：
 * 1. in-flight 单飞去重（D4-2）：同 key 并发请求共享同一执行 Promise（snapshotStatus/numstat
 *    按 cwd 键，getStatus 按 sessionId+cwd 组合键），执行完成即离开去重表。
 * 2. 分层 TTL 缓存（D4-3）：
 *    - snapshotStatus / numstat **不缓存结果**（turn 内 diff 需当前真实状态，缓存会漏报变更），
 *      只做单飞去重；
 *    - getStatus 短 TTL 缓存，键 = sessionId+cwd 组合（GitStatusResult 内嵌 sessionId 且前端按其
 *      路由，按 cwd 单键会让共享同 cwd 的两个 session 串扰——D4-3 修正定案）；
 *    - 「非仓库」判定 cwd 级负缓存（60s）：仅 stderr 明确报 not a git repository 时写入；
 *      超时/不可用等瞬态失败**不写**（git 稍后可能恢复，缓存不会因失败写入错误值）。
 * 3. invalidate(sessionId)（D4-3）：写操作后调用，清该 session 的缓存与在飞条目。在飞条目被标记
 *    dead——完成后不回写缓存，防止「失效后旧值复活」竞态。
 *
 * W16 阶段说明：本实现暂不被生产路径消费（组合根不实例化），仅由单测实例化验证；
 * W17（git-service.getStatus 收编）接线。
 *
 * 🔒 三层架构：本文件属 services（编排 + 缓存策略），IO 经 IGitExecutor port；
 * 解析复用 infra 纯函数（git-status-parser / file-change-reconciler 的 parseGitStatusPorcelain、
 * xyToStatus——无 IO 纯计算，与 git-service.ts import infra/git/git-status-parser 同款豁免）。
 */
import type { FileChangeStatus, GitStatusResult } from '@xyz-agent/shared'
import {
  parseGitStatus,
  deriveCounts,
  parseNumstat,
  parseNumstatByFile,
  parseNumstatEntries,
} from '../../infra/git/git-status-parser.js'
import { parseGitStatusPorcelain, xyToStatus } from '../../infra/pi/file-change-reconciler.js'
import type { GitCommand, GitExecutorResult, IGitExecutor } from '../ports/git-executor.js'
import type { IGitStateService, NumstatEntry, StatusSnapshot } from '../ports/git-state.js'

// D3-1 超时定案：snapshotStatus/numstat 沿用 reconciler 现状 5000ms；getStatus 沿用
// git-executor 默认 8000ms（显式传参防 executor 默认值变化时语义漂移）。
const SNAPSHOT_TIMEOUT_MS = 5000
const STATUS_TIMEOUT_MS = 8000
/** getStatus 结果 TTL（D4-3「短 TTL 如 2s」）。 */
const STATUS_TTL_MS = 2000
/** 非仓库负缓存 TTL（D4-3「较长如 60s」）——非仓库场景每次 turn 都 spawn git 探测是最大浪费。 */
const NOT_REPO_TTL_MS = 60_000
/** getStatus 缓存键分隔符（sessionId 与 cwd 都可能含 '/'，用 NUL 防拼接歧义）。 */
const KEY_SEP = '\0'

/** getStatus 的在飞条目：dead 标记用于 invalidate 竞态防护（完成后不回写缓存）。 */
interface InflightGetStatus {
  promise: Promise<GitStatusResult>
  dead: boolean
}

export interface GitStateServiceOptions {
  executor: IGitExecutor
  /** 测试可注入短 TTL（默认 2000ms）。 */
  statusTtlMs?: number
  /** 测试可注入短负缓存 TTL（默认 60s）。 */
  notRepoTtlMs?: number
}

/** getStatus 成功聚合结果才缓存；null 哨兵 = 降级路径（非仓库/不可用/超时），调用方转 notRepoResult。 */
type GetStatusOutcome = GitStatusResult | null

export class GitStateService implements IGitStateService {
  private readonly executor: IGitExecutor
  private readonly statusTtlMs: number
  private readonly notRepoTtlMs: number

  private readonly inflightSnapshot = new Map<string, Promise<StatusSnapshot>>()
  private readonly inflightNumstat = new Map<string, Promise<Map<string, NumstatEntry> | null>>()
  private readonly inflightGetStatus = new Map<string, InflightGetStatus>()
  private readonly statusCache = new Map<string, { result: GitStatusResult; ts: number }>()
  /** cwd → 判定为非仓库的时刻（ms）。 */
  private readonly notRepoCache = new Map<string, number>()

  constructor(opts: GitStateServiceOptions) {
    this.executor = opts.executor
    this.statusTtlMs = opts.statusTtlMs ?? STATUS_TTL_MS
    this.notRepoTtlMs = opts.notRepoTtlMs ?? NOT_REPO_TTL_MS
  }

  async snapshotStatus(cwd: string, opts?: { force?: boolean }): Promise<StatusSnapshot> {
    if (!opts?.force && this.isNotRepo(cwd)) return null
    const inflight = this.inflightSnapshot.get(cwd)
    if (inflight) return inflight
    const promise = this.runSnapshotStatus(cwd).finally(() => this.inflightSnapshot.delete(cwd))
    this.inflightSnapshot.set(cwd, promise)
    return promise
  }

  private async runSnapshotStatus(cwd: string): Promise<StatusSnapshot> {
    try {
      const res = await this.execGit(cwd, 'status', ['--porcelain'], SNAPSHOT_TIMEOUT_MS)
      if (res.exitCode !== 0) {
        this.maybeMarkNotRepo(cwd, res)
        return null
      }
      const snapshot = new Map<string, FileChangeStatus>()
      for (const { xy, path } of parseGitStatusPorcelain(res.stdout)) {
        snapshot.set(path, xyToStatus(xy))
      }
      return snapshot
    } catch {
      // git 不可用 / 超时 → null（与 reconciler 现状降级一致）；瞬态失败不写缓存
      return null
    }
  }

  async numstat(cwd: string): Promise<Map<string, NumstatEntry> | null> {
    if (this.isNotRepo(cwd)) return null
    const inflight = this.inflightNumstat.get(cwd)
    if (inflight) return inflight
    const promise = this.runNumstat(cwd).finally(() => this.inflightNumstat.delete(cwd))
    this.inflightNumstat.set(cwd, promise)
    return promise
  }

  private async runNumstat(cwd: string): Promise<Map<string, NumstatEntry> | null> {
    try {
      const res = await this.execGit(cwd, 'diff', ['--numstat', 'HEAD'], SNAPSHOT_TIMEOUT_MS)
      if (res.exitCode !== 0) {
        this.maybeMarkNotRepo(cwd, res)
        return null
      }
      return new Map(parseNumstatEntries(res.stdout).map((e) => [e.path, e]))
    } catch {
      // numstat 失败 → null，调用方（W18 computeLineCounts）走 writeContents 回退（现状语义）
      return null
    }
  }

  async getStatus(sessionId: string, cwd: string): Promise<GitStatusResult> {
    // 非仓库负缓存命中 → 直接降级（零 spawn，V5：非仓库用户的每次 turn / 面板刷新不再探测）
    if (this.isNotRepo(cwd)) return fallbackResult(sessionId)
    const key = statusCacheKey(sessionId, cwd)
    const cached = this.statusCache.get(key)
    if (cached && Date.now() - cached.ts < this.statusTtlMs) return cached.result
    const inflight = this.inflightGetStatus.get(key)
    if (inflight) return inflight.promise

    const entry: InflightGetStatus = { dead: false, promise: Promise.resolve(fallbackResult(sessionId)) }
    entry.promise = this.runGetStatus(sessionId, cwd).then((outcome) => {
      // 降级路径（null 哨兵）不缓存；invalidate 判死的执行不回写（防旧值复活竞态）
      if (outcome !== null && !entry.dead) {
        this.statusCache.set(key, { result: outcome, ts: Date.now() })
      }
      return outcome ?? fallbackResult(sessionId)
    })
    this.inflightGetStatus.set(key, entry)
    // 完成/失败都离开去重表（后续调用走缓存或重新执行）；仅删除自己，防止误删 invalidate 后新发起的条目
    const cleanup = () => {
      if (this.inflightGetStatus.get(key) === entry) this.inflightGetStatus.delete(key)
    }
    entry.promise.then(cleanup, cleanup)
    return entry.promise
  }

  /**
   * 聚合 status + numstat + branch（D4-1「一次调用内并发执行」：status 先行——非仓库判定
   * 依赖它；numstat 与 branch 并发）。聚合/解析逻辑与 git-service.getStatus 现状逐段等价
   * （W17 收编时行为不变的前提）。
   */
  private async runGetStatus(sessionId: string, cwd: string): Promise<GetStatusOutcome> {
    try {
      // status --porcelain=v1 -z -b --untracked-files=all（与 git-service 现状一致：
      // -uall 展开 untracked 目录到文件级，AGENTS.md #15，与 snapshotStatus 裸 --porcelain 有意区分）
      const statusRes = await this.execGit(
        cwd,
        'status',
        ['--porcelain=v1', '-z', '-b', '--untracked-files=all'],
        STATUS_TIMEOUT_MS,
      )
      if (statusRes.exitCode !== 0) {
        this.maybeMarkNotRepo(cwd, statusRes)
        return null
      }
      const { branch, files } = parseGitStatus(statusRes.stdout)
      const { stagedCount, unstagedCount, hasConflict } = deriveCounts(files)

      const [numstatSettled, branchSettled] = await Promise.allSettled([
        this.execGit(cwd, 'diff', ['--numstat', 'HEAD'], STATUS_TIMEOUT_MS),
        this.execGit(cwd, 'branch', ['--list', '--format=%(refname:short)'], STATUS_TIMEOUT_MS),
      ])
      // numstat/branch 是同一聚合查询的组成部分（非独立数据源）：任一 rejected（git 不可用/超时）
      // 即整体降级——与 git-service.getStatus 现状「串行 await 任一异常 → catch 降级」行为等价
      if (numstatSettled.status === 'rejected' || branchSettled.status === 'rejected') {
        return null
      }
      const numstatRes = numstatSettled.value
      const branchRes = branchSettled.value

      // stats：tracked 改动行数聚合。无 HEAD（空仓库）时 diff 失败 → 0（现状语义）
      let stats = { add: 0, del: 0 }
      if (numstatRes.exitCode === 0) {
        stats = parseNumstat(numstatRes.stdout)
        // per-file 行数填充（+N −M 角标）：numstat 不含 untracked/unmerged/二进制 → 保持 undefined
        const numstatMap = parseNumstatByFile(numstatRes.stdout)
        for (const file of files) {
          const ns = numstatMap.get(file.path)
          if (ns) {
            file.additions = ns.add
            file.deletions = ns.del
          }
        }
      }

      let branches: string[] = []
      if (branchRes.exitCode === 0) {
        branches = branchRes.stdout
          .split('\n')
          .map((b) => b.trim())
          .filter((b) => b.length > 0)
      }

      return {
        sessionId,
        isRepo: true,
        branch,
        branches,
        stagedCount,
        unstagedCount,
        stats,
        hasConflict,
        files,
      }
    } catch {
      // git 不可用 / 超时 / 未知错误 → 降级 isRepo:false（与 git-service.getStatus catch 降级一致）
      return null
    }
  }

  invalidate(sessionId: string): void {
    const prefix = `${sessionId}${KEY_SEP}`
    for (const key of this.statusCache.keys()) {
      if (key.startsWith(prefix)) this.statusCache.delete(key)
    }
    for (const [key, entry] of this.inflightGetStatus) {
      if (key.startsWith(prefix)) {
        // 标 dead（完成后不回写缓存）+ 移出去重表（下一次调用重新执行，不拿旧值）
        entry.dead = true
        this.inflightGetStatus.delete(key)
      }
    }
    // 负缓存不清：写操作（stage/commit/checkout…）不改变「是否仓库」判定，语义稳定
  }

  private isNotRepo(cwd: string): boolean {
    const ts = this.notRepoCache.get(cwd)
    return ts !== undefined && Date.now() - ts < this.notRepoTtlMs
  }

  /** 仅「确定非仓库」写负缓存；超时/不可用等瞬态失败不写（缓存不因失败写入错误值）。 */
  private maybeMarkNotRepo(cwd: string, res: GitExecutorResult): void {
    if (/not a git repository/i.test(res.stderr)) {
      this.notRepoCache.set(cwd, Date.now())
    }
  }

  private execGit(cwd: string, command: GitCommand, args: string[], timeoutMs: number): Promise<GitExecutorResult> {
    return this.executor.exec(cwd, command, args, { timeoutMs })
  }
}

/** 非 git 仓库 / git 不可用时的降级结果（与 git-service.notRepoResult 同形状）。 */
function fallbackResult(sessionId: string): GitStatusResult {
  return {
    sessionId,
    isRepo: false,
    stagedCount: 0,
    unstagedCount: 0,
    stats: { add: 0, del: 0 },
    hasConflict: false,
    files: [],
  }
}

function statusCacheKey(sessionId: string, cwd: string): string {
  return `${sessionId}${KEY_SEP}${cwd}`
}
