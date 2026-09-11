/**
 * export-diagnostic-bundle 单测（crash-forensics-and-watchdog §3.3 D6，验收 A1/A2）。
 *
 * 覆盖：
 * - A1 收集清单：条目与来源路径逐项断言（双台账/各层日志尾部/水位摘录/summary.md）；
 *   缺文件（台账尚无 runtime.jsonl、logs 空、run 目录缺）清单降级进 missing 不抛错
 * - A2 zip 结构：listZipEntries（实现反向验证面）列条目与清单一致；失败路径返回具体
 *   errno（ENOSPC 类盘错误无法稳定注入，以 ENOENT 目录不存在为锚）
 * - 评估器状态表进 summary.md（构造越线 fixture → WARN 行 + tripped 状态出现）
 * - 知情文案随包携带（summary.privacyNotice = shared 常量）+ DiagnosticReports 指引
 *
 * 全部夹具 mkdtempSync(tmpdir) 自建自删（fs-guard 生效中）；env 注入 XYZ_AGENT_DATA_DIR
 * 重定向 getDataDir 推导（对齐 log-retention-ipc.test.ts 形态）。
 * 运行：cd apps/electron/main && npx vitest run diagnostics/__tests__/export-diagnostic-bundle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildDiagnosticEntries,
  exportDiagnosticBundle,
  extractLatestPiVersion,
  extractRecentWatermarkLines,
  tailBytes,
  normalizeFsError,
} from '../export-diagnostic-bundle.js'
import { listZipEntries, buildZipArchive } from '../minimal-zip.js'
import { DIAGNOSTIC_EXPORT_PRIVACY_NOTICE } from '@xyz-agent/shared'

const NOW = Date.parse('2026-09-10T12:00:00Z')
const MS_PER_HOUR = 60 * 60 * 1000

/** 写入日志文件并把 mtime 设为 ageHours 小时前（家族「最新一份」按 mtime 判定的驱动器）。 */
function touch(file: string, content: string, ageHours = 0): void {
  writeFileSync(file, content)
  const mtime = new Date(NOW - ageHours * MS_PER_HOUR)
  utimesSync(file, mtime, mtime)
}

/** 台账行（D1 schema 最小字段集；piVersion 供提取断言）。 */
function journalLine(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: new Date(NOW).toISOString(), layer: 'runtime', event, ...extra })
}

describe('export-diagnostic-bundle（crash-forensics D6 u3a）', () => {
  let tmpDir: string
  let savedDataDir: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'diag-bundle-test-'))
    savedDataDir = process.env.XYZ_AGENT_DATA_DIR
    process.env.XYZ_AGENT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.XYZ_AGENT_DATA_DIR
    else process.env.XYZ_AGENT_DATA_DIR = savedDataDir
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function writeFixture(): void {
    const logsDir = join(tmpDir, 'logs')
    const crashesDir = join(logsDir, 'crashes')
    const runDir = join(tmpDir, 'run')
    mkdirSync(crashesDir, { recursive: true })
    mkdirSync(runDir, { recursive: true })
    // 双台账现档：main 带 registry-miss 佐证与 piVersion，runtime 带 watermark-daily 与 detailPath 引用
    writeFileSync(join(crashesDir, 'main.jsonl'), `${journalLine('registry-miss')}\n`)
    writeFileSync(
      join(crashesDir, 'runtime.jsonl'),
      [
        journalLine('crash', { layer: 'pi', sessionId: 'sid-1', reason: 'extension-error', piVersion: '0.84.4', detailPath: 'logs/pi-crash-20260910.log' }),
        journalLine('watermark-daily', { rss: 100, heapUsed: 50 }),
        '',
      ].join('\n'),
    )
    // 各层日志家族（每家族最新一份；runtime 家族放两份验证 mtime 择新）
    touch(join(logsDir, 'runtime-2026-09-08.log'), 'old runtime log\n', 48)
    touch(join(logsDir, 'runtime-2026-09-10.log'), `[${new Date(NOW - MS_PER_HOUR).toISOString()}] [INFO] [watermark] rss=1.0MB heapUsed=0.5MB heapTotal=2.0MB external=0.1MB sessions=1 pi=1\n`, 1)
    touch(join(logsDir, 'main-2026-09-10.log'), 'main log tail\n', 0)
    touch(join(logsDir, 'renderer-error-2026-09-10.log'), 'renderer stack\n', 2)
    touch(join(logsDir, 'pi-2026-09-10-sid-1.jsonl'), '{"stdout":"line"}\n', 1)
    // detailPath 引用的深查文件 + run 运行态
    touch(join(logsDir, 'pi-crash-20260910.log'), 'pi stderr tail\n', 1)
    writeFileSync(join(runDir, 'main-running.marker'), 'pid\n')
    writeFileSync(join(runDir, 'runtime-checkpoint.json'), '{}')
  }

  // ── A1 收集清单 ─────────────────────────────────────────────────────────────

  describe('A1 buildDiagnosticEntries 收集清单', () => {
    it('清单条目与来源路径逐项齐整（台账/日志尾部/水位/detailPath/summary）', () => {
      writeFixture()
      const result = buildDiagnosticEntries({ appVersion: '0.9.16', now: NOW })

      const byPath = new Map(result.entries.map((e) => [e.archivePath, e]))
      // 双台账现档
      expect(byPath.get('crashes/main.jsonl')?.sourcePath).toBe(join(tmpDir, 'logs', 'crashes', 'main.jsonl'))
      expect(byPath.get('crashes/runtime.jsonl')?.tailBytes).toBeUndefined()
      // 各层日志尾部：每家族 mtime 最新一份，tailBytes = 256KB
      expect(byPath.get('logs/runtime-2026-09-10.log')?.sourcePath).toBe(join(tmpDir, 'logs', 'runtime-2026-09-10.log'))
      expect(byPath.get('logs/runtime-2026-09-08.log')).toBeUndefined()
      expect(byPath.get('logs/main-2026-09-10.log')?.tailBytes).toBe(256 * 1024)
      expect(byPath.get('logs/renderer-error-2026-09-10.log')?.sourcePath).toBeDefined()
      expect(byPath.get('logs/pi-2026-09-10-sid-1.jsonl')?.sourcePath).toBeDefined()
      // 台账 detailPath 引用的深查文件
      expect(byPath.get('logs/pi-crash-20260910.log')?.sourcePath).toBe(join(tmpDir, 'logs', 'pi-crash-20260910.log'))
      // 水位摘录（生成条目）+ summary.md
      const watermark = byPath.get('watermark-recent-24h.log')
      expect(watermark?.content).toContain('[watermark] rss=1.0MB')
      const summary = byPath.get('summary.md')
      expect(summary?.content).toContain('# xyz-agent 诊断包')
      // 全量清单（1 水位 + 1 summary + 2 台账 + 4 日志家族 + 1 detailPath = 9 条）
      expect(result.entries).toHaveLength(9)
      // 环境信息
      expect(result.environment.appVersion).toBe('0.9.16')
      expect(result.environment.piVersion).toBe('0.84.4')
      expect(result.environment.markerPresent).toBe(true)
      expect(result.environment.checkpointPresent).toBe(true)
      // 齐整 fixture 无降级
      expect(result.missing).toEqual([])
    })

    it('缺文件降级不抛错：台账缺 runtime.jsonl、logs 空、run 目录缺失逐项进 missing', () => {
      // 只建 main 台账，无 logs 目录、无 run 目录
      mkdirSync(join(tmpDir, 'logs', 'crashes'), { recursive: true })
      writeFileSync(join(tmpDir, 'logs', 'crashes', 'main.jsonl'), `${journalLine('reload')}\n`)

      const result = buildDiagnosticEntries({ now: NOW })

      const missingPaths = result.missing.map((m) => m.archivePath)
      expect(missingPaths).toContain('crashes/runtime.jsonl')
      expect(missingPaths).toContain('logs/runtime-*')
      expect(missingPaths).toContain('watermark-recent-24h.log')
      expect(result.entries.map((e) => e.archivePath)).toContain('crashes/main.jsonl')
      expect(result.entries.map((e) => e.archivePath)).toContain('summary.md')
      // 评估器照常出表：缺 runtime 台账 → 相关行 no-data 显式（非静默空白）
      expect(result.evaluated.rows).toHaveLength(20)
      expect(() => JSON.stringify(result)).not.toThrow()
    })

    it('评估器状态表进 summary.md：越线条件出现 WARN 行与 tripped 状态', () => {
      mkdirSync(join(tmpDir, 'logs', 'crashes'), { recursive: true })
      // registry-miss 一次即越线（附录 A #2「任何一次即触发」）
      writeFileSync(join(tmpDir, 'logs', 'crashes', 'runtime.jsonl'), `${journalLine('registry-miss')}\n`)

      const result = buildDiagnosticEntries({ now: NOW })
      const summary = result.entries.find((e) => e.archivePath === 'summary.md')?.content ?? ''

      expect(result.evaluated.trippedIds).toContain(2)
      expect(summary).toContain('**WARN：1 条越线（#2）**')
      expect(summary).toContain('触发条件状态表')
      expect(summary).toMatch(/\| 2 \|/) // #2 行在状态表内
    })

    it('水位摘录只取窗口内行：24h 外与无时间戳行不收', () => {
      const content = [
        `[${new Date(NOW - 25 * MS_PER_HOUR).toISOString()}] [INFO] [watermark] rss=stale`,
        `[${new Date(NOW - 1 * MS_PER_HOUR).toISOString()}] [INFO] [watermark] rss=fresh`,
        '[watermark] rss=no-timestamp',
        `[${new Date(NOW).toISOString()}] [INFO] other line`,
        '',
      ].join('\n')
      const lines = extractRecentWatermarkLines(content, NOW)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('rss=fresh')
    })

    it('tailBytes 截尾与全量边界；normalizeFsError 保留 errno', () => {
      expect(tailBytes(Buffer.from('abcdef'), 3).toString()).toBe('def')
      expect(tailBytes(Buffer.from('ab'), 3).toString()).toBe('ab')
      const enospc = Object.assign(new Error('no space left'), { code: 'ENOSPC' })
      expect(normalizeFsError(enospc)).toEqual({ code: 'ENOSPC', message: 'no space left' })
      expect(normalizeFsError(new Error('boom')).code).toBe('EUNKNOWN')
    })

    it('extractLatestPiVersion 取最近事件的 piVersion，无记录为 unknown', () => {
      expect(extractLatestPiVersion([])).toBe('unknown')
      expect(extractLatestPiVersion([journalLine('crash', { piVersion: '0.84.4' })])).toBe('0.84.4')
      expect(
        extractLatestPiVersion([
          JSON.stringify({ ts: new Date(NOW - 3600_000).toISOString(), layer: 'runtime', event: 'crash', piVersion: '0.83.0' }),
          journalLine('crash', { piVersion: '0.84.4' }),
        ]),
      ).toBe('0.84.4')
    })
  })

  // ── A2 zip 结构 ─────────────────────────────────────────────────────────────

  describe('A2 exportDiagnosticBundle zip 结构', () => {
    it('产物可打开：listZipEntries 列条目与清单一致，summary.md 内容含版本/指引/知情文案', () => {
      writeFixture()
      const outPath = join(tmpDir, 'out', 'diag.zip')
      mkdirSync(join(tmpDir, 'out'))

      const result = exportDiagnosticBundle({ outPath, appVersion: '0.9.16', now: NOW })

      expect(result.status).toBe('exported')
      if (result.status !== 'exported') return
      expect(existsSync(outPath)).toBe(true)
      expect(result.bytes).toBe(readFileSync(outPath).length)
      // 反向验证：central directory 条目与清单一致
      const zipNames = listZipEntries(readFileSync(outPath))
      expect(zipNames).toEqual(result.entryNames)
      expect(zipNames).toContain('summary.md')
      expect(zipNames).toContain('crashes/main.jsonl')
      expect(zipNames).toContain('crashes/runtime.jsonl')
      expect(zipNames).toContain('watermark-recent-24h.log')
      // summary.md 内容断言（版本/触发表/DiagnosticReports 指引/知情文案）——
      // 从收集面断言（zip 内字节与收集面同源，同参数下 buildDiagnosticEntries 确定性输出）
      const collected = buildDiagnosticEntries({ appVersion: '0.9.16', now: NOW })
      const summary = collected.entries.find((e) => e.archivePath === 'summary.md')?.content ?? ''
      expect(summary).toContain('app 版本：0.9.16')
      expect(summary).toContain('pi 版本：0.84.4')
      expect(summary).toContain('DiagnosticReports')
      expect(summary).toContain('~/Library/Logs/DiagnosticReports/')
      expect(summary).toContain('会话标识')
      // payload 携带知情文案（A4）
      expect(result.summary.privacyNotice).toBe(DIAGNOSTIC_EXPORT_PRIVACY_NOTICE)
      expect(result.summary.evaluatedConditionCount).toBe(20)
      expect(result.summary.entryCount).toBe(result.entryCount)
      expect(result.summary.piVersion).toBe('0.84.4')
    })

    it('尾部截取生效：超 256KB 的日志只收末 256KB', () => {
      const logsDir = join(tmpDir, 'logs')
      mkdirSync(logsDir, { recursive: true })
      const big = ('x'.repeat(1024) + '\n').repeat(300) // ~300KB
      touch(join(logsDir, 'main-2026-09-10.log'), big)

      const result = exportDiagnosticBundle({ outPath: join(tmpDir, 'diag.zip'), now: NOW })

      expect(result.status).toBe('exported')
      const collected = buildDiagnosticEntries({ now: NOW })
      const mainEntry = collected.entries.find((e) => e.archivePath === 'logs/main-2026-09-10.log')
      expect(mainEntry?.tailBytes).toBe(256 * 1024)
      expect(readFileSync(join(tmpDir, 'logs', 'main-2026-09-10.log')).length).toBeGreaterThan(256 * 1024)
    })

    it('失败路径返回具体 errno：outPath 目录不存在 → error.code = ENOENT', () => {
      writeFixture()
      const result = exportDiagnosticBundle({ outPath: join(tmpDir, 'no-such-dir', 'diag.zip'), now: NOW })

      expect(result.status).toBe('error')
      if (result.status !== 'error') return
      expect(result.error.code).toBe('ENOENT')
      expect(result.error.message).not.toBe('')
    })

    it('listZipEntries 对非 zip 缓冲返回 null（读取器健壮性）', () => {
      expect(listZipEntries(Buffer.from('not a zip'))).toBeNull()
    })
  })
})
