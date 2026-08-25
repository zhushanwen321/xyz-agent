/**
 * 用量统计扫描服务（W1 数据层）
 *
 * 扫描 session JSONL 目录，按 pi 三分类（assistant / toolResult-with-usage /
 * compaction-with-usage）聚合 Token 用量，返回 UsageRow[]。
 *
 * 缓存策略：per-file 分片 (mtimeMs, size) 双键（D9）——append-only 场景下
 * mtime 不变但 size 变仍能 miss。
 */

import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { getSessionsDir } from '../../infra/pi/pi-paths.js'
import type { UsageMetrics, UsageRow, UsageStatsResult } from '@xyz-agent/shared'

// ── 分片类型 ─────────────────────────────────────────────────

interface FileShard {
  mtimeMs: number
  size: number
  rows: UsageRow[]
  skippedLines: number
  cwd: string | null
}

// ── 服务主体 ─────────────────────────────────────────────────

export class UsageStatsService {
  private readonly sessionsDir: string
  private readonly shards = new Map<string, FileShard>()

  constructor(sessionsDir: string = getSessionsDir()) {
    this.sessionsDir = sessionsDir
  }

  /**
   * 聚合全部 session 文件的用量数据。
   *
   * 流程：readdir + stat → 比对 (mtimeMs, size) 双键 → 未变用分片、变化/新增重读、删除丢分片 → 拼装。
   */
  async getStats(): Promise<UsageStatsResult> {
    const scannedAt = Date.now()
    const allRows: UsageRow[] = []
    let skippedLines = 0
    let sessionCount = 0

    let entries: string[]
    try {
      entries = await readdir(this.sessionsDir)
    } catch {
      // 目录不存在或不可读 → 返回空结果
      return { rows: [], scannedAt, sessionCount: 0, skippedLines: 0 }
    }

    // 收集当前磁盘文件路径，用于清理已删除文件的分片
    const currentPaths = new Set<string>()

    for (const entry of entries) {
      // 文件过滤：复刻 isScannableSessionFile 规则
      // 排除 .tmp-migrate-*.jsonl（归一化崩溃残留）和 .jsonl.meta.json（sidecar）
      if (!entry.endsWith('.jsonl')) continue
      if (entry.includes('.tmp-migrate-')) continue

      const filePath = `${this.sessionsDir}/${entry}`
      let fileStat
      try {
        fileStat = await stat(filePath)
      } catch {
        continue
      }
      // 跳过目录
      if (!fileStat.isFile()) continue

      currentPaths.add(filePath)
      const cached = this.shards.get(filePath)

      // (mtimeMs, size) 双键比对（D9）
      if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
        // 未变文件：直接用分片
        allRows.push(...cached.rows)
        skippedLines += cached.skippedLines
        sessionCount++
        continue
      }

      // 变化/新增文件：重读
      const shard = await this.scanFile(filePath, fileStat)
      this.shards.set(filePath, shard)
      allRows.push(...shard.rows)
      skippedLines += shard.skippedLines
      sessionCount++
    }

    // 清理已删除文件的分片
    for (const key of this.shards.keys()) {
      if (!currentPaths.has(key)) {
        this.shards.delete(key)
      }
    }

    return { rows: allRows, scannedAt, sessionCount, skippedLines }
  }

  /**
   * 流式扫描单个 JSONL 文件，按 pi 三分类计入 usage。
   *
   * 计入规则（对齐 getUsageCostBreakdown，均带 usage 存在性守卫）：
   * ① type==='message' && message.role==='assistant' && message.usage → 主桶
   * ② type==='message' && message.role==='toolResult' && message.usage → compaction 虚拟桶
   * ③ (type==='compaction' || type==='branch_summary') && entry.usage → compaction 虚拟桶
   *
   * @returns FileShard 分片（含 rows, skippedLines, cwd）
   */
  private async scanFile(filePath: string, fileStat: { mtimeMs: number; size: number }): Promise<FileShard> {
    const rows: UsageRow[] = []
    let skippedLines = 0
    let cwd: string | null = null
    let foundSessionEntry = false

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })

    for await (const line of rl) {
      if (!line.trim()) continue

      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        skippedLines++
        continue
      }

      // 提取 cwd：逐行读直到找到第一个 type==='session' entry
      // 容错首行为 session_info 的旧文件——继续读找 session entry
      if (!foundSessionEntry && entry.type === 'session' && typeof entry.cwd === 'string') {
        cwd = entry.cwd
        foundSessionEntry = true
      }

      const type = entry.type as string | undefined
      const message = entry.message as Record<string, unknown> | undefined
      const role = message?.role as string | undefined

      // ① assistant 主桶
      if (type === 'message' && role === 'assistant' && message?.usage) {
        const usage = message.usage as Record<string, unknown>
        const provider = message.provider as string | undefined
        const model = (message.responseModel ?? message.model) as string | undefined
        const date = toLocalDate(entry.timestamp as string)
        if (date === null) {
          skippedLines++
          continue
        }

        rows.push(this.makeRow(date, provider ?? '(unknown)', model ?? '(unknown)', cwd, usage))
        continue
      }

      // ② toolResult-with-usage → compaction 虚拟桶
      if (type === 'message' && role === 'toolResult' && message?.usage) {
        const usage = message.usage as Record<string, unknown>
        const date = toLocalDate(entry.timestamp as string)
        if (date === null) {
          skippedLines++
          continue
        }

        rows.push(this.makeRow(date, 'compaction', 'compaction', cwd, usage))
        continue
      }

      // ③ compaction / branch_summary with entry.usage → compaction 虚拟桶
      if ((type === 'compaction' || type === 'branch_summary') && entry.usage) {
        const usage = entry.usage as Record<string, unknown>
        const date = toLocalDate(entry.timestamp as string)
        if (date === null) {
          skippedLines++
          continue
        }

        rows.push(this.makeRow(date, 'compaction', 'compaction', cwd, usage))
        continue
      }

      // 其余行 continue
    }

    return {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      rows,
      skippedLines,
      cwd,
    }
  }

  /**
   * 构造 UsageRow，从 usage 对象提取指标。
   * usage 存在性守卫：缺失字段按 0。
   */
  private makeRow(
    date: string,
    provider: string,
    model: string,
    cwd: string | null,
    usage: Record<string, unknown>,
  ): UsageRow {
    const metrics = extractMetrics(usage)
    const project = this.extractProject(cwd)
    return { ...metrics, date, provider, model, project }
  }

  /** 从 cwd 提取 project（basename）。 */
  private extractProject(cwd: string | null): string {
    if (!cwd) return '(unknown)'
    const name = basename(cwd)
    return name || '(unknown)'
  }
}

/** 从 usage 对象提取 UsageMetrics 字段，缺失按 0。messages 语义：每行恰代表一个计入事件（主桶一条消息 / 虚拟桶一个压缩或摘要事件）。 */
function extractMetrics(usage: Record<string, unknown>): UsageMetrics {
  const input = typeof usage.input === 'number' ? usage.input : 0
  const output = typeof usage.output === 'number' ? usage.output : 0
  const cacheRead = typeof usage.cacheRead === 'number' ? usage.cacheRead : 0
  const cacheWrite = typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0

  let costUSD = 0
  const cost = usage.cost as Record<string, unknown> | undefined
  if (cost && typeof cost.total === 'number') {
    costUSD = cost.total
  }

  const messages = 1

  return { input, output, cacheRead, cacheWrite, costUSD, messages }
}
/**
 * UTC timestamp → 本地时区 'YYYY-MM-DD'（D6）；非法/缺失 timestamp 返回 null（行级失败，计入 skippedLines）。
 *
 * 用 Intl.DateTimeFormat 'sv-SE' locale 保证 ISO 格式输出，timeZone 缺省 = 本地时区。
 * 禁止 toISOString().slice(0,10)（UTC 切日会让晚 8 点后的用量算到「明天」）。
 * dateFormatter 为模块级复用实例（逐行 new 实测慢 ~37x @60k 行）。
 */
const dateFormatter = new Intl.DateTimeFormat('sv-SE')
function toLocalDate(timestamp: string): string | null {
  if (!timestamp) return null
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return null
  // Intl.DateTimeFormat 的 timeZone 缺省值 = 运行环境本地时区（Node.js 下 = 系统时区）
  return dateFormatter.format(d)
}
