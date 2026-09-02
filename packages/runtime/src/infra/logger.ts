/**
 * Runtime 日志持久化模块（架构约定 #4）。
 *
 * [HISTORICAL] 背景：handoff 2026-07-04 P1「pi 静默卡死」——坏 session 的 JSONL 只有 2 行、
 * 零 message，pi 子进程 0% CPU 不退出。runtime 发了 prompt 后 pi 发了什么事件（或什么都没发）
 * 无法事后追溯，因为日志只在 concurrently 终端，关掉即丢。本模块把 runtime + pi 日志持久化
 * 到文件，并按天/大小轮转，避免磁盘膨胀。
 *
 * 设计（perf W30 / 06 §3.3 D10-1、D10-2）：
 * - 纯 node:fs 自实现轮转，**零第三方依赖**（不动 tsup noExternal，规避规则 #12 摩擦）
 * - **WriteStream 缓冲写**：主日志与 pi session log 均用 createWriteStream(flags:'a') 常驻写流，
 *   替代 appendFileSync 同步盘写（旧实现的每行同步写是热路径阻塞点）
 * - date 轮转：按天文件名（runtime-YYYY-MM-DD.log），跨天 end 旧流 → 惰性开新日期流
 * - size 轮转：按**写入字节计数**（替代 statSync）触发 .1 滚动，顺序硬约束（审查 m-6）：
 *   **end 旧流 → rename → 开新流**——且必须**异步等待旧流 'close'（全部在途 fs.write 落盘）
 *   后再 rename**：rename 早于 flush 完成时，旧流在途写会落进已改名 inode，而单代 .1
 *   在下一次轮转时被新 inode 覆盖路径，在途数据随之丢失（探针实测每个轮转边界丢 ~2 行）。
 *   轮转窗口内到达的写入行暂存内存队列，新流就绪后按序回放（窗口通常 <1ms）
 * - 保留期：启动时清理 KEEP_DAYS 天前的日志
 * - 级别：dev 默认 debug，prod 默认 info，XYZ_LOG_LEVEL 可覆盖（XYZ_ 前缀自动过白名单）
 * - pi stdout JSONL 独立落盘：pi-<sessionId>.jsonl（卡死诊断的决定性证据）
 * - 退出 flush（D10-1 分档承诺的配套）：shutdown 链必须 `await closeLogger()`（主日志 +
 *   全部 pi session 写流 end 并等 flush 完成）后再 process.exit(0)；硬崩溃（SIGKILL/断电）
 *   丢缓冲窗口内尾部几行已声明为取证能力削弱
 * - 挂起兜底（审查 W30 Fix-1）：endAndAwait 等 'close' 有 5s 超时降级——超时强制销毁流 +
 *   记 error 级日志（fs 挂起时 closeLogger/轮转不永久阻塞），轮转窗口 pendingLines 有
 *   10_000 行容量上限（超限丢弃、合并记一次 warn）
 *
 * 用法（组合根 index.ts 初始化）：
 *   initLogger(getDataDir())                // 初始化全局 logger + patch console
 *   const sessionLog = createPiSessionLog(sessionId)  // pi stdout tee
 *   sessionLog.write(line)
 *   sessionLog.end()
 *   await closeLogger()                     // shutdown：flush 所有写流后进程才可退出
 */
import { createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, type WriteStream } from 'node:fs'
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

// ── 主日志写流状态（D10-1：WriteStream 缓冲写 + 字节计数轮转）─────────
/** 主日志当前写流（按日期惰性打开）；跨天 / size 轮转时 end 后置 undefined。 */
let mainStream: WriteStream | undefined
/** mainStream 对应的文件路径（轮转 rename 目标用）。 */
let mainStreamFile: string | undefined
/** 自本次打开以来写入主日志的字节数（size 轮转判定，替代每行 statSync）。 */
let mainBytesWritten = 0

/** 异步轮转进行中（end 旧流等待 flush 完成 → rename → 开新流）。 */
let rotationInFlight: Promise<void> | null = null
/** 轮转窗口内到达的写入行（新流就绪后按序回放；窗口通常 <1ms）。 */
const pendingLines: Array<{ line: string; bytes: number }> = []
/** pendingLines 容量上限：fs 挂起时轮转窗口无限拉长，无界入队会内存膨胀（审查 W30 Fix-1）。 */
const MAX_PENDING_LINES = 10_000
/** 当前轮转窗口内因超限丢弃的行数（轮转结束后合并记一次 warn，不在热路径递归记日志）。 */
let pendingDroppedCount = 0

/** endAndAwait 等待写流 'close' 的超时：fs 挂起时 close 永不触发，超时降级 resolve（防永久挂起）。 */
const END_AWAIT_TIMEOUT_MS = 5_000

// ── pi session 写流注册表（D10-1 退出 flush：closeLogger 统一 end + 等待）──
interface PiStreamState {
  /** 惰性打开：首次 write 才建流。 */
  stream: WriteStream | undefined
  /** end() 已调（write 后续为 no-op）。保留注册直到 closeLogger，确保退出 flush 覆盖。 */
  ended: boolean
  /** 目标文件路径（closeLogger 端 endAndAwait 超时报告的 label 用）。 */
  file: string
}
const openPiStreams = new Set<PiStreamState>()

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
 * 把消息中的换行折叠为单行分隔符（终审 minor）。
 *
 * 为什么：日志文件按「一行一条目」组织（时间戳 + 级别前缀），多行消息（如 index.ts
 * shutdown 的 `\n[runtime] received SIGTERM...` 模板串）会拆出「无时间戳的裸次行」，
 * 破坏 grep 与行级解析。在 writeLogEntry（写行唯一出口）折叠，覆盖 console patch
 * （formatArgs 产出）与显式 logger 调用两条入口；终端输出（originalConsole）保持原样。
 * 首尾换行直接去除（调用点用前导 \n 与终端前序输出隔行是终端可读性习惯，文件里无意义），
 * 中间换行折叠为 ' | ' 保留行边界。
 */
function foldNewlines(s: string): string {
  return s.replace(/^[\r\n]+|[\r\n]+$/g, '').replace(/[\r\n]+/g, ' | ')
}

/**
 * 内部：写一条日志到 runtime 主日志文件（含级别 + 时间戳前缀）。
 *
 * D10-1 起为 WriteStream 缓冲写：write() 只入 Node 内部缓冲（非阻塞），
 * 由事件循环异步落盘——热路径（streaming 期间每事件 console 输出）不再有同步盘写。
 * 轮转判定用写入字节计数（mainBytesWritten），替代旧 appendFileSync 方案的每行 statSync。
 *
 * 轮转是异步的（end 旧流须等待 flush 完成才能 rename，见 rotateMain）；轮转窗口内
 * 到达的行先入 pendingLines 队列，由 rotateMain 续体在新流就绪后按序回放——同步写入
 * 路径在轮转期间零阻塞、零丢失。
 */
function writeLogEntry(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!currentLevel || !logsDir) return
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return
  const today = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  const metaStr = meta ? ' ' + JSON.stringify(meta) : ''
  // JSON.stringify(meta) 不产生裸换行（转义为 \\n），无需折叠；message 统一折叠单行化
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${foldNewlines(message)}${metaStr}\n`
  const bytes = Buffer.byteLength(line, 'utf8')
  try {
    // 轮转进行中（end 旧流等待 flush 的窗口）：行先入队，续体在新流就绪后回放。
    if (rotationInFlight) {
      // 容量上限（审查 W30 Fix-1）：fs 挂起时轮转窗口无限拉长，无界入队会内存膨胀；
      // 超限行丢弃并计数，轮转结束后合并记一次 warn（见 rotateMain，不在热路径递归记日志）。
      if (pendingLines.length >= MAX_PENDING_LINES) {
        pendingDroppedCount++
        return
      }
      pendingLines.push({ line, bytes })
      return
    }
    // 跨天：end 旧流（旧日期文件保持原状）→ 开新日期流。异步轮转，本行入队。
    if (currentDate !== today) {
      if (mainStream) {
        void rotateMain(today, false)
        pendingLines.push({ line, bytes })
        return
      }
      currentDate = today
    }
    // size 轮转（写入字节计数）：超阈值 → 异步「end 旧流 → rename → 开新流」，本行入队。
    if (mainStream && mainStreamFile && mainBytesWritten + bytes > MAX_FILE_BYTES) {
      void rotateMain(today, true)
      pendingLines.push({ line, bytes })
      return
    }
    if (!mainStream) {
      openMainStream(today)
    }
    const stream = mainStream
    if (!stream) return // 打开失败（异常路径）→ 本轮丢弃，不抛
    // write 返回 false = 背压（缓冲堆积）。日志行量级 KB、磁盘正常不触发；慢盘时内存
    // 增长与轮转窗口 pendingLines 同源，已由容量上限兜底（审查 W30 Fix-6）。
    stream.write(line)
    mainBytesWritten += bytes
  // eslint-disable-next-line taste/no-silent-catch -- logger 自身写入失败（磁盘满/权限等）不能杀进程；console 已被 patch，无可靠诊断出口，吞没是刻意容错
  } catch {
    // no-op
  }
}

/**
 * 异步轮转主日志：end 旧流并**等待 flush 完成** →（size 轮转时）rename → 开新流 → 回放队列。
 *
 * 顺序硬约束（06 §3.3 D10-1 / 审查 m-6）：必须先等旧流 'close'（fd 关闭、全部在途
 * fs.write 落盘）再 rename——否则 rename 后旧流在途写会落进已改名 inode，而单代 .1
 * 在下一次轮转时被新 inode 覆盖路径，在途数据随之丢失（探针实测：rename 早于 flush
 * 完成时每个轮转边界丢 ~2 行）。
 *
 * 幂等并发：轮转窗口内的重复触发复用同一 promise（写入行统一走 pendingLines 队列）。
 */
function rotateMain(nextToday: string, renameOld: boolean): Promise<void> {
  if (rotationInFlight) return rotationInFlight
  const oldStream = mainStream
  const oldFile = mainStreamFile
  // 状态先行清空：轮转窗口内到达的行统一入队（writeLogEntry 的 rotationInFlight 分支）
  mainStream = undefined
  mainStreamFile = undefined
  mainBytesWritten = 0
  rotationInFlight = (async () => {
    if (oldStream) await endAndAwait(oldStream, `main-rotation:${oldFile ?? 'unnamed'}`)
    if (renameOld && oldFile) {
      try {
        renameSync(oldFile, `${oldFile}.1`)
      // eslint-disable-next-line taste/no-silent-catch -- 轮转失败（rename IO 错/权限）不阻塞写入；logger 自身容错，吞没是刻意设计
      } catch {
        // no-op（rename 失败：新流仍写主文件，仅丢失滚动，数据不丢）
      }
    }
    currentDate = nextToday
    const stream = openMainStream(nextToday)
    // 回放轮转窗口内到达的行（续体在微任务队列原子执行，无并发写入插队）
    const pending = pendingLines.splice(0)
    if (stream) {
      for (const p of pending) {
        stream.write(p.line)
        mainBytesWritten += p.bytes
      }
    } else if (pending.length > 0) {
      // 新流打开失败（终审 suggestion）：已 splice 出的回放行无目标流可写，丢弃但必须
      // 计数——对齐超限丢弃的 pendingDroppedCount 出口（不静默），由下方合并 warn 报数
      pendingDroppedCount += pending.length
    }
    rotationInFlight = null
    // 轮转窗口超长（fs 挂起）导致的超限丢弃：合并记一次 warn。此时 rotationInFlight 已清，
    // writeLogEntry 走正常路径（写新流），不递归。受影响的只是缓冲窗口内的日志行——降级可接受。
    if (pendingDroppedCount > 0) {
      const dropped = pendingDroppedCount
      pendingDroppedCount = 0
      writeLogEntry('warn', `[logger] dropped ${dropped} log lines (pending queue overflow / replay target unavailable during rotation)`)
    }
  })()
  return rotationInFlight
}

/**
 * 为 WriteStream 挂容错 'error' 监听器（磁盘满/权限等异步写错误，无监听器会升级为
 * uncaughtException）。
 *
 * 静默吞、不记 console：console 已被 patch（console.error → writeLogEntry），error 处理
 * 里再记 console 会与写失败互相触发形成递归。仅丢日志、不杀进程（与旧 appendFileSync
 * 的 try/catch 容错契约一致）。首个 error 降级记一次**受限出口**——writeLogEntry 直写
 * 主日志文件、不经 console，其自身失败静默（写失败路径已由本监听器吞掉），不构成递归。
 */
function attachStreamErrorHandler(stream: WriteStream, label: string): void {
  let first = true
  stream.on('error', () => {
    if (!first) return
    first = false
    writeLogEntry('warn', `[logger] write stream error (${label}); further errors suppressed`)
  })
}

/**
 * 打开（或重开）当天主日志写流。惰性：仅在首次写入 / 跨天 / size 轮转后调用。
 *
 * 打开前若磁盘上既有文件已超阈值（如上次运行崩溃未轮转、历史大文件），先滚动一次——
 * 进程内字节计数不覆盖历史，此 stat 弥合跨重启的 size 上限（仅打开时一次，非热路径）。
 *
 * 返回新流（失败返回 undefined）。调用方应使用返回值而非重读 mainStream——TS 对
 * 模块级变量的 CFA 会在「先赋 undefined 再读」的闭包路径里把 mainStream 窄化为
 * undefined，直接读会得到 never。
 */
function openMainStream(today: string): WriteStream | undefined {
  if (!logsDir) return undefined
  const file = join(logsDir, `runtime-${today}.log`)
  try {
    if (existsSyncSafe(file) && statSync(file).size > MAX_FILE_BYTES) {
      renameSync(file, `${file}.1`)
    }
  // eslint-disable-next-line taste/no-silent-catch -- 打开前滚动失败不阻塞写入；best-effort 容错
  } catch {
    // no-op
  }
  const stream = createStreamSafe(file)
  if (!stream) return undefined
  attachStreamErrorHandler(stream, `main:${file}`)
  mainStream = stream
  mainStreamFile = file
  mainBytesWritten = 0
  return stream
}

/**
 * createWriteStream 的容错包装（终审 suggestion 配套）：同步抛错（非法路径 / EMFILE 等）
 * 归一为 undefined，兑现 openMainStream「失败返回 undefined」的注释承诺。不包装时异常会
 * 沿 rotateMain 的 rotationInFlight promise 传播为 unhandled rejection（writeLogEntry 的
 * `void rotateMain(...)` 不 await），且 rotateMain 的回放丢弃计数分支（stream 为 undefined）
 * 因此具备真实可达路径。
 */
function createStreamSafe(file: string): WriteStream | undefined {
  try {
    return createWriteStream(file, { flags: 'a' })
  } catch {
    // 打开失败归一 undefined 由调用方降级（回放丢弃计数）；logger 自身容错，不杀进程
    return undefined
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

// ── 显式 logger 导出（架构约定 #4 落盘）──────────────────────────────
//
// 除 monkey-patch console 外，提供显式 logger 对象供「不依赖 console patch」的场景使用。
// 内部调 writeLogEntry，与 patched console 同源（同文件/同级别/同轮转）。
// 未 initLogger 时为 no-op（单元测试不依赖文件系统）。

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    writeLogEntry('debug', message, meta)
  },
  info(message: string, meta?: Record<string, unknown>): void {
    writeLogEntry('info', message, meta)
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    writeLogEntry('warn', message, meta)
  },
  error(message: string, meta?: Record<string, unknown>): void {
    writeLogEntry('error', message, meta)
  },
}

// ── pi session 日志（pi stdout JSONL 原始流落盘）────────────────────

export interface PiSessionLog {
  /**
   * 写入 pi stdout 原始内容（不格式化——保留协议原貌供事后分析）。
   * string = 行级写入（readline 消费方契约，缺尾换行补齐）；Uint8Array = 原始字节镜像
   * （relay up 方向 chunk，流自带换行边界，逐字节保真、不补 \n——chunk 可能切断多字节
   * 字符，按 Buffer 写避免按 chunk 解码的 UTF-8 截断）。
   */
  write(line: string | Uint8Array): void
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
 * D10-2：接口形状不变（end 后 write 为 no-op），内部从 appendFileSync 换成 WriteStream
 * 缓冲写（惰性打开）。end() 只关闭本 session 写流；注册表保留条目，closeLogger 退出
 * flush 时统一等待全部写流（含已 end 未 flush 完的）落盘——pi 静默卡死场景丢尾部
 * 几行 = 丢「pi 挂在最后哪一步」的冒烟证据（D10-1 分档承诺）。
 */
export function createPiSessionLog(sessionId: string): PiSessionLog {
  if (!logsDir || !currentLevel) {
    // logger 未初始化（如单元测试）：返回 no-op 写入器
    return { write: () => {}, end: () => {} }
  }
  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  // 文件名：pi-<date>-<sessionId>.jsonl（date 防跨天 session 冲突）
  const safeSid = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, SESSION_ID_MAX_LENGTH)
  return createPiStreamWriter(join(logsDir, `pi-${date}-${safeSid}.jsonl`))
}

/**
 * 为一个 relay 托管的 subagent 子进程创建 stdout 原始字节镜像写入器（E 方案，
 * relay-registry 的 up 方向落盘；架构约定「pi stdout tee 落盘 = pi 卡死时唯一证据」
 * 对 relay 子进程的同款覆盖）。
 *
 * 文件名 `pi-relay-<date>-<recordId>.jsonl`（pi- 前缀对齐既有命名，cleanExpiredLogs
 * 的保留期清理同样覆盖；date 前缀防跨天冲突）。recordId 来自握手帧（extension 注入），
 * 按文件名安全字符集清洗。logger 未初始化时返回 no-op 写入器（与 createPiSessionLog
 * 同契约，单元测试无副作用）。
 */
export function createPiRelayLog(recordId: string): PiSessionLog {
  if (!logsDir || !currentLevel) {
    return { write: () => {}, end: () => {} }
  }
  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  const safeRecordId = recordId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, SESSION_ID_MAX_LENGTH)
  return createPiStreamWriter(join(logsDir, `pi-relay-${date}-${safeRecordId}.jsonl`))
}

/**
 * pi 崩溃 stderr 全量落盘（设计 file-lock-unification-and-reaper-sink §3.2-D4 / U3-4，
 * rpc-client exit handler 的异常退出分支调用）。
 *
 * 文件名 `pi-crash-<date>-<sessionId>.log`：复用 pi-*.jsonl 命名惯例（pi- 前缀使
 * cleanExpiredLogs 的保留期清理自动覆盖，无需改过滤规则）；date + sessionId 防同日
 * 多 session / 跨天冲突。sessionId 缺失（无 session 的早期 spawn 崩溃）用 'nosid' 占位。
 *
 * 写入复用 createPiStreamWriter（WriteStream 缓冲 + 惰性打开 + closeLogger 退出 flush
 * 覆盖 + 流错误自愈）而非 appendFileSync——logger.ts 写入路径禁同步 append 是
 * logger.test.ts 的源码硬保证（grep 断言），且崩溃落盘后 runtime 可能很快 shutdown，
 * 注册进 openPiStreams 保证 closeLogger 等待其落盘完成。
 *
 * 未初始化（单元测试）no-op；重复调用（同 session 多次崩溃理论上不可能，防御性
 * 支持）append 语义不覆盖历史。内容为 best-effort：写失败不向上抛（调用方在 exit
 * 主流程上，观测增强不得影响 rejectAll / exitCallbacks 通知链）。
 */
export function writePiCrashLog(sessionId: string | undefined, content: string): void {
  if (!logsDir || !currentLevel) return
  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH)
  // 文件名安全化与 createPiSessionLog 同规则；空清洗结果（如全非法字符）回落 'nosid'
  const safeSid = (sessionId ?? 'nosid').replace(/[^a-zA-Z0-9-]/g, '').slice(0, SESSION_ID_MAX_LENGTH) || 'nosid'
  const writer = createPiStreamWriter(join(logsDir, `pi-crash-${date}-${safeSid}.log`))
  writer.write(content.endsWith('\n') ? content : content + '\n')
  writer.end()
}

/**
 * pi 原始流写入器的共享实现（createPiSessionLog / createPiRelayLog / writePiCrashLog 共用）：
 * WriteStream 缓冲写 + 惰性打开 + destroyed 自愈重建，条目注册进 openPiStreams 由
 * closeLogger 统一等待退出 flush。失败语义 best-effort：同步异常静默吞、异步流错误由
 * attachStreamErrorHandler 记一次 warn——绝不向上抛（调用方是数据转发热路径）。
 */
function createPiStreamWriter(file: string): PiSessionLog {
  const state: PiStreamState = { stream: undefined, ended: false, file }
  openPiStreams.add(state)
  return {
    write: (line) => {
      if (state.ended) return // end 后 no-op
      if (!currentLevel || !logsDir) return // closeLogger 后 no-op（与 writeLogEntry 一致，审查 W30 Fix-8）
      const data = typeof line === 'string' ? (line.endsWith('\n') ? line : line + '\n') : line
      try {
        // 写入前守卫（审查 W30 Fix-9）：writableEnded = end() 已调、flush 未完（正常被
        // state.ended 拦截，此处防御外部直接调 stream.end() 的场景）——等同 end 语义，no-op。
        if (state.stream?.writableEnded) return
        // 自愈（审查 W30 Fix-2）：流 error 后 autoDestroy，write 静默丢弃；pi session log
        // 是 pi 卡死诊断的决定性证据，静默丢失后续行 = 失去冒烟证据（主日志有轮转自愈、
        // pi 流没有）——destroyed 时重建（flags:'a' 续写同文件 + 重新挂 error 监听器）。
        if (!state.stream || state.stream.destroyed) {
          // 重建前摘掉旧流的 error 监听（审查 W30 Fix-9）：destroyed 流不会再 emit，
          // 但显式移除避免悬挂监听器持有旧流引用（防监听器泄漏/重复注册）。
          // 可选链：首次惰性打开时 stream 为 undefined（此分支为 true 的主路径）。
          state.stream?.removeAllListeners('error')
          state.stream = createWriteStream(file, { flags: 'a' })
          attachStreamErrorHandler(state.stream, `pi:${file}`)
        }
        // write 返回 false = 背压（缓冲堆积）。日志行量级 KB、磁盘正常不触发；慢盘时
        // 内存增长与轮转窗口 pendingLines 同源，已由容量上限兜底（审查 W30 Fix-6）。
        state.stream.write(data)
      // eslint-disable-next-line taste/no-silent-catch -- pi stdout 落盘失败（磁盘满/权限）不影响 runtime 主流程；best-effort 容错
      } catch {
        // no-op
      }
    },
    end: () => {
      if (state.ended) return
      state.ended = true
      state.stream?.end() // 缓冲数据异步 flush 后关闭 fd；closeLogger 会等待其完成
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

/**
 * end 一个写流并等待其真正关闭（'close' 事件，fd 已释放、缓冲已 flush）。
 *
 * 退出 flush（D10-1）与轮转（审查 m-6）的核心：process.exit() 立即终止进程、rename
 * 前必须有「无在途写」保证——都要求 end 后**等待落盘完成**，否则缓冲窗口内的尾部日志
 * 在退出时丢失 / 轮转边界在途写被 orphaning。
 *
 * 永不 reject（best-effort）：'error' 也 resolve，避免日志模块阻塞进程退出。
 *
 * 超时降级（审查 W30 Fix-1）：fs 挂起时 'close' 永不触发，等待 END_AWAIT_TIMEOUT_MS 后
 * resolve 并**强制销毁流**（destroy 释放 fd、丢弃在途缓冲）——轮转续体照常 rename
 * （rename 失败可容忍、数据不丢，见 rotateMain），closeLogger 不会永久挂起阻塞 SIGTERM
 * 处理器（supervisor 无需升级 SIGKILL）。代价：超时销毁丢弃在途缓冲尾部几行（与硬崩溃
 * 取证能力削弱同档，已声明可接受）。
 */
function endAndAwait(stream: WriteStream | undefined, label: string): Promise<void> {
  if (!stream) return Promise.resolve()
  if (stream.closed) return Promise.resolve() // 已关闭（含已 error 销毁的流）
  if (!stream.writableEnded) stream.end()
  if (stream.closed) return Promise.resolve() // 同步关闭路径（如测试用 fake 流）
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (timedOut: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 清理 once 链（审查 W30 Fix-9）：'close' 先触发时 'error' 监听器仍挂残留，
      // 超时/事件到达后手动移除，避免悬挂监听器持有已关闭流的引用。
      stream.removeListener('close', onClose)
      stream.removeListener('error', onError)
      if (timedOut) {
        // 强制销毁（审查 W30 Fix-1）：不 destroy 则 fd 悬挂、「close」永不触发，
        // 后续轮转/退出若再 end 同一流仍会挂满一个超时窗口。无参 destroy 不 emit
        // 'error'（上面的 error 监听器也已摘除），不会产生未捕获异常。
        stream.destroy()
        reportEndAwaitTimeout(label)
      }
      resolve()
    }
    const onClose = () => finish(false)
    const onError = () => finish(false)
    const timer = setTimeout(() => finish(true), END_AWAIT_TIMEOUT_MS)
    timer.unref?.() // 超时定时器不 holding 事件循环（fs 正常时 close 远早于超时到达）
    stream.once('close', onClose)
    stream.once('error', onError)
  })
}

/**
 * endAndAwait 超时的错误出口（审查 W30 Fix-1：记 error 级日志，防「静默降级」放大日志丢失）。
 *
 * 双出口：writeLogEntry 走常规写路径（轮转场景入 pendingLines、轮转后回放落盘；
 * closeLogger 后 currentLevel 已清则 no-op）；originalConsole.error 是**未 patch 的原生
 * console**（不递归进 writeLogEntry），stderr 由 supervisor 捕获落盘——超时意味着 fs
 * 本身可能挂起，文件路径不可靠时 stderr 是兜底出口。轮转窗口队列满时文件路被丢弃
 * （计入 pendingDroppedCount，随合并 warn 报数），stderr 恒可达。
 */
function reportEndAwaitTimeout(label: string): void {
  const msg = `[logger] endAndAwait timeout after ${END_AWAIT_TIMEOUT_MS}ms (${label}); stream force-destroyed, in-flight buffer tail lost`
  writeLogEntry('error', msg)
  originalConsole.error(msg)
}

/**
 * 关闭 logger（runtime shutdown 时调）。
 *
 * **必须 await**：先等待进行中的轮转完成（队列回放），再 end 主日志写流 + 全部已注册
 * pi session 写流，并等待 flush 完成——之后调用方才可 process.exit(0)（现状 index.ts
 * shutdown 链已改为 await closeLogger()）。
 *
 * 幂等：再次调用（或 closeLogger 后的写入）均为 no-op。
 */
export async function closeLogger(): Promise<void> {
  if (rotationInFlight) await rotationInFlight
  // 先捕获所有写流引用再清状态——await 窗口内新写入应直接 no-op，
  // 捕获的旧流照常 end + 等待（退出前最后几行不丢）。
  const streams: Array<{ stream: WriteStream | undefined; label: string }> = [
    { stream: mainStream, label: `main-shutdown:${mainStreamFile ?? 'unnamed'}` },
  ]
  for (const s of openPiStreams) streams.push({ stream: s.stream, label: `pi-shutdown:${s.file}` })
  mainStream = undefined
  mainStreamFile = undefined
  mainBytesWritten = 0
  pendingLines.length = 0
  openPiStreams.clear()
  currentLevel = undefined
  logsDir = undefined
  currentDate = ''
  // 各写流独立且 endAndAwait 永不 reject——allSettled 与 all 等价，但符合
  // taste/prefer-allsettled（独立数据源允许部分降级，不互相阻塞）。
  await Promise.allSettled(streams.map(({ stream, label }) => endAndAwait(stream, label)))
}
