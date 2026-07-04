/**
 * Runtime 日志持久化模块（架构约定 #4）。
 *
 * [HISTORICAL] 背景：handoff 2026-07-04 P1「pi 静默卡死」——坏 session 的 JSONL 只有 2 行、
 * 零 message，pi 子进程 0% CPU 不退出。runtime 发了 prompt 后 pi 发了什么事件（或什么都没发）
 * 无法事后追溯，因为日志只在 concurrently 终端，关掉即丢。本模块把 runtime + pi 日志持久化
 * 到文件，并按天/大小轮转，避免磁盘膨胀。
 *
 * 设计：
 * - 纯 node:fs 自实现轮转，**零第三方依赖**（不动 tsup noExternal，规避规则 #12 摩擦）
 * - date 轮转：按天文件名（runtime-YYYY-MM-DD.log），跨天自动切新文件
 * - size 轮转：单文件超 MAX_FILE_BYTES 触发 .1 滚动（rename 旧文件，新开主文件）
 * - 保留期：启动时清理 KEEP_DAYS 天前的日志
 * - 级别：dev 默认 debug，prod 默认 info，XYZ_LOG_LEVEL 可覆盖（XYZ_ 前缀自动过白名单）
 * - pi stdout JSONL 独立落盘：pi-<sessionId>.jsonl（卡死诊断的决定性证据）
 *
 * 用法（组合根 index.ts 初始化）：
 *   initLogger(getDataDir())          // 初始化全局 logger + patch console
 *   const sessionLog = createPiSessionLog(sessionId)  // pi stdout tee
 *   sessionLog.write(line)
 *   sessionLog.end()
 */
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isPackaged } from '../utils/runtime-env.js'

// ── 级别 ────────────────────────────────────────────────────────────
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function parseLevel(env: string | undefined, fallback: LogLevel): LogLevel {
  const v = (env ?? '').toLowerCase()
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v
  return fallback
}

// ── 轮转常量（env 可覆盖，走 XYZ_ 白名单前缀自动透传）────────────────
const BYTES_PER_KB = 1024
const DEFAULT_MAX_FILE_MB = 50
const MAX_FILE_BYTES = Number(process.env.XYZ_LOG_MAX_BYTES) || DEFAULT_MAX_FILE_MB * BYTES_PER_KB * BYTES_PER_KB
const DEFAULT_KEEP_DAYS = 7
const KEEP_DAYS = Number(process.env.XYZ_LOG_KEEP_DAYS) || DEFAULT_KEEP_DAYS
const SECONDS_PER_MINUTE = 60
const HOURS_PER_DAY = 24
const MS_PER_SECOND = 1000
const MS_PER_DAY = HOURS_PER_DAY * SECONDS_PER_MINUTE * SECONDS_PER_MINUTE * MS_PER_SECOND
/** ISO 日期 YYYY-MM-DD 的字符长度。 */
const ISO_DATE_LENGTH = 10
/** UUID v7 长度上限（pi sessionId 是 UUID，截断防超长文件名）。 */
const SESSION_ID_MAX_LENGTH = 36

/** 当前级别（initLogger 时定，模块级单例）。未 init 前为 undefined，所有写入降级为 no-op。 */
let currentLevel: LogLevel | undefined
let logsDir: string | undefined

/** 当前 runtime 主日志的日期（YYYY-MM-DD），跨天检测用。 */
let currentDate = ''

/**
 * 初始化全局 logger。组合根（index.ts main 最早处）调用一次。
 *
 * 副作用：
 * 1. 创建 logsDir（<dataDir>/logs/）
 * 2. 清理过期日志（KEEP_DAYS 天前）
 * 3. monkey-patch console.log/warn/error → tee（终端 + 文件）
 *
 * 未调用时（如单元测试），console 保持原生，所有 logger 写入为 no-op——
 * 保证测试不依赖文件系统、不产生副作用。
 */
export function initLogger(dataDir: string): void {
  if (currentLevel) return // 已初始化（幂等）
  logsDir = join(dataDir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  // dev 默认 debug（含 pi 事件流），prod 默认 info（屏蔽 pi 原始事件，避 PII/性能/磁盘）
  currentLevel = parseLevel(process.env.XYZ_LOG_LEVEL, isPackaged() ? 'info' : 'debug')
  cleanExpiredLogs()
  patchConsole()
  writeLogEntry('info', '[logger] initialized', { level: currentLevel, dir: logsDir })
}

/**
 * 内部：写一条日志到 runtime 主日志文件（含级别 + 时间戳前缀）。
 *
 * 用同步 appendFileSync 而非 writeStream——日志是诊断用，非高频热路径，
 * 同步写入保证 statSync 读到的 size 真实，轮转判断准确。性能可接受。
 */
function writeLogEntry(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!currentLevel || !logsDir) return
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  // 跨天：更新 currentDate，新日志写新文件（旧文件保留，不主动关闭流——同步写入无流）
  if (currentDate !== today) {
    currentDate = today
  }
  rotateIfNeeded(today)
  const file = join(logsDir, `runtime-${today}.log`)
  const ts = new Date().toISOString()
  const metaStr = meta ? ' ' + JSON.stringify(meta) : ''
  try {
    appendFileSync(file, `[${ts}] [${level.toUpperCase()}] ${message}${metaStr}\n`)
  // eslint-disable-next-line taste/no-silent-catch -- logger 自身写入失败（磁盘满/权限等）不能杀进程；console 已被 patch，无可靠诊断出口，吞没是刻意容错
  } catch {
    // no-op
  }
}

/**
 * size 轮转：若当天主文件超 MAX_FILE_BYTES，滚动为 .1（单代滚动）。
 * 写前检查，保证单文件不超阈值。同步写入后立即 stat，无 flush 延迟。
 */
function rotateIfNeeded(today: string): void {
  if (!logsDir) return
  const file = join(logsDir, `runtime-${today}.log`)
  try {
    if (existsSyncSafe(file) && statSync(file).size > MAX_FILE_BYTES) {
      renameSync(file, join(logsDir, `runtime-${today}.log.1`))
    }
  // eslint-disable-next-line taste/no-silent-catch -- 轮转失败（stat/rename IO 错）不阻塞写入；logger 自身容错，吞没是刻意设计
  } catch {
    // no-op
  }
}

/** 清理 KEEP_DAYS 天前的日志文件（启动时调一次）。 */
function cleanExpiredLogs(): void {
  if (!logsDir) return
  const cutoff = Date.now() - KEEP_DAYS * MS_PER_DAY
  let entries: string[]
  try {
    entries = readdirSync(logsDir)
  } catch {
    return
  }
  for (const name of entries) {
    // 只清理本模块产出的日志文件（runtime-* / pi-*.jsonl）
    if (!name.startsWith('runtime-') && !name.startsWith('pi-')) continue
    const full = join(logsDir, name)
    try {
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full)
      }
    // eslint-disable-next-line taste/no-silent-catch -- 单文件清理失败（并发删除/权限）不影响其他文件；best-effort 容错
    } catch {
      // no-op
    }
  }
}

// ── console monkey-patch（tee：终端 + 文件）────────────────────────
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
}

let consolePatched = false
function patchConsole(): void {
  if (consolePatched) return
  consolePatched = true
  // 保留终端可见性（dev 习惯），同时 tee 到文件。
  // 注意：supervisor 仍捕获 runtime stdout → [runtime:out] 前缀，tee 不影响这条链路。
  console.log = (...args: unknown[]) => {
    originalConsole.log(...args)
    writeLogEntry('info', formatArgs(args))
  }
  console.info = (...args: unknown[]) => {
    originalConsole.info(...args)
    writeLogEntry('info', formatArgs(args))
  }
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args)
    writeLogEntry('warn', formatArgs(args))
  }
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args)
    writeLogEntry('error', formatArgs(args))
  }
  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...args)
    writeLogEntry('debug', formatArgs(args))
  }
}

/** 把 console 的多参数序列化为单行字符串（含对象 JSON 化）。 */
function formatArgs(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }).join(' ')
}

// ── pi session 日志（pi stdout JSONL 原始流落盘）────────────────────

export interface PiSessionLog {
  /** 写一行 pi stdout（原始 JSONL，不格式化——保留协议原貌供事后分析）。 */
  write(line: string): void
  /** 结束写入（session 销毁 / pi exit 时调）。end 后 write 为 no-op。 */
  end(): void
}

/**
 * 为一个 pi session 创建独立日志写入器。
 *
 * pi stdout 的 JSONL 事件流是诊断 pi 卡死的**决定性证据**（pi 发了什么 / 什么都没发）。
 * 每个独立文件，文件名含 sessionId 便于关联坏 session（与 ~/.xyz-agent-dev/pi/sessions/
 * 下的 session JSONL 对应）。
 *
 * 不轮转：单 session 事件量可控（正常 turn <1000 事件），session 结束即 end()。
 * 若极端长 session 导致文件过大，事后可手动清理（保留期 cleanExpiredLogs 会清 7 天前）。
 *
 * 用同步 appendFileSync（与主日志一致，简化 + 保证写入顺序）。
 * end 后 write 为 no-op（防御：pi exit handler 可能晚于最后的 stdout line）。
 */
export function createPiSessionLog(sessionId: string): PiSessionLog {
  if (!logsDir || !currentLevel) {
    // logger 未初始化（如单元测试）：返回 no-op 写入器
    return { write: () => {}, end: () => {} }
  }
  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  // 文件名：pi-<date>-<sessionId>.jsonl（date 防跨天 session 冲突）
  const safeSid = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, SESSION_ID_MAX_LENGTH)
  const file = join(logsDir, `pi-${date}-${safeSid}.jsonl`)
  let ended = false
  return {
    write: (line: string) => {
      if (ended) return // end 后 no-op
      const data = line.endsWith('\n') ? line : line + '\n'
      try {
        appendFileSync(file, data)
      // eslint-disable-next-line taste/no-silent-catch -- pi stdout 落盘失败（磁盘满/权限）不影响 runtime 主流程；best-effort 容错
      } catch {
        // no-op
      }
    },
    end: () => {
      ended = true
    },
  }
}

// ── 工具 ────────────────────────────────────────────────────────────
function existsSyncSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** 重置 logger 状态（runtime shutdown 时调；同步写入无流需关闭，仅清模块状态）。 */
export function closeLogger(): void {
  currentLevel = undefined
  logsDir = undefined
  currentDate = ''
}
