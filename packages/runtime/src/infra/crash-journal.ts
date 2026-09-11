/**
 * 崩溃台账 runtime writer（crash-forensics-and-watchdog.md §3.3 D1，实施单元 u1b）。
 *
 * 职责：runtime 进程侧死亡/自愈/条件信号事件的统一落盘——`<dataDir>/logs/crashes/runtime.jsonl`
 * （双文件形态的 runtime 半边：main 侧事件由 main 侧双胞胎 writer 写 main.jsonl，
 * 消除跨进程写竞争——D1 被否②）。事件类型消费 @xyz-agent/shared 的 schema SSOT
 * （crash-journal-schema.ts，u1a），本模块不复制定义。
 *
 * 轮转形态（复用 logger.ts 已验证形态而非重造，D1 证据行）：
 * - **写入字节计数**（替代每行 statSync）触发 size 轮转，默认单档 10MB（构造参数可
 *   注入小阈值供测试）；
 * - **末 3 段级联 rename**：runtime.jsonl → .jsonl.1 → .jsonl.2，最旧（.2）删除——多段
 *   级联是本设计对 logger 单代 `.1` 形态的扩展（D1 原文），级联机制本身（end 旧流等
 *   flush → rename → 开新流的顺序硬约束）照搬 logger.ts 审查 m-6 结论：rename 早于
 *   flush 完成时在途写落进已改名 inode，段级联覆盖路径时数据随之丢失；
 * - **pendingLines 防丢**：轮转窗口内到达的行入内存队列，新流就绪后按序回放（容量
 *   上限 10_000 行防 fs 挂起时无界膨胀，超限丢弃合并记一次 warn）；
 * - **endAndAwait 超时降级**：等流 'close' 有 5s 上限，fs 挂起时强制销毁流不永久阻塞。
 *
 * 清理只依赖自带轮转（D1）：crashes/ 是 logs/ 的子目录，cleanExpiredLogs 只认顶层平铺
 * 前缀、结构性跳过子目录——台账不进 7 天保留期清理，寿命由 3 段 ×10MB 自界。
 *
 * best-effort 语义（日志类设施契约）：append 为 fire-and-forget，任何写入失败（磁盘满/
 * 权限/序列化异常）不向调用方业务链抛错；异步流错误经 error 监听器记一次主日志 warn
 * 后静默（对齐 logger.ts attachStreamErrorHandler 的 once 形态）。close() 供 shutdown
 * 链与测试取确定性 flush 点（end 后 append 为 no-op）。
 *
 * 单例风格对齐 logger.ts：initCrashJournal(dataDir) 组合根调一次；未初始化时
 * getCrashJournal() 返回 no-op writer（单元测试零副作用）。
 */
import { createWriteStream, mkdirSync, renameSync, statSync, unlinkSync, type WriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type CrashJournalEvent,
  type CrashJournalWriter,
  type CrashJournalWriterOptions,
} from '@xyz-agent/shared'
import { getDataDir } from '@xyz-agent/shared/paths'
import { logger } from './logger.js'
// endAndAwait 单一实现（偏差 #32①：原模块私有复刻与 logger.ts 同构，收敛共享原语；
// 超时留痕出口 reportEndAwaitTimeout 保持本模块注入）
import { END_AWAIT_TIMEOUT_MS, endAndAwaitStream } from './stream-end-await.js'

/** 字节换算基数（对齐 logger.ts 既有 BYTES_PER_KB 惯例，禁裸 1024）。 */
const BYTES_PER_KB = 1024

/** 单档默认上限 MB（设计 D1：单文件 10MB size 轮转）。 */
const DEFAULT_MAX_FILE_MB = 10

/** 单档默认上限（字节）。 */
const DEFAULT_MAX_FILE_BYTES = DEFAULT_MAX_FILE_MB * BYTES_PER_KB * BYTES_PER_KB

/** 级联段后缀（旧 → 新）。`.2` 最旧、先删；活跃档无后缀。 */
const SEGMENT_SUFFIXES = ['.1', '.2'] as const

/** 轮转窗口 pending 队列容量上限（fs 挂起时防无界膨胀，对齐 logger.ts 审查 W30 Fix-1）。 */
const MAX_PENDING_LINES = 10_000

/**
 * runtime 侧台账 writer（扩展 schema 的 CrashJournalWriter 契约，附加 close 收口）。
 * main 侧双胞胎（u1c）实现同款 close 语义；两实现共用 schema 类型不复制定义。
 */
export interface CrashJournalFileWriter extends CrashJournalWriter {
  /**
   * 等待进行中的轮转完成后 end 当前流并等待 flush 落盘；幂等，end 后 append 为 no-op。
   * shutdown 链挂点（对齐 closeLogger 形态）与测试的确定性 flush 点。
   */
  close(): Promise<void>
}

/** writer 构造选项（schema CrashJournalWriterOptions 的 runtime 侧扩展，不改 SSOT）。 */
export interface CrashJournalWriterCreateOptions extends CrashJournalWriterOptions {
  /**
   * 数据根目录；缺省 getDataDir() 动态推导（排查规则：禁止硬编码绝对路径）。
   * 台账落位 `<dataDir>/logs/crashes/<role>.jsonl`，目录不存在自动创建。
   */
  dataDir?: string
  /** 单档字节上限；缺省 10MB。测试注入小阈值触发轮转。 */
  maxFileBytes?: number
}

/**
 * 创建台账 writer 实例（单例的内部实现，测试直接构造注入小阈值）。
 *
 * 构造即创建 crashes/ 目录；目录创建失败（ENOTDIR/权限）时 writer 降级为永久 no-op
 * 并记一次主日志 warn——台账是旁路设施，不得因自身故障放大为调用链故障。
 */
export function createCrashJournalWriter(opts: CrashJournalWriterCreateOptions): CrashJournalFileWriter {
  const dataDir = opts.dataDir ?? getDataDir()
  const baseFile = join(dataDir, 'logs', 'crashes', `${opts.role}.jsonl`)
  let dirReady = false
  try {
    mkdirSync(dirname(baseFile), { recursive: true })
    dirReady = true
  } catch {
    reportWriteFailureOnce(`crashes dir create failed: ${dirname(baseFile)}`)
  }
  return new CrashJournalFileWriterImpl(baseFile, opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, dirReady)
}

class CrashJournalFileWriterImpl implements CrashJournalFileWriter {
  /** 活跃档写流；惰性打开（首次 append / 轮转后 / 流错误后重开）。undefined = 待开。 */
  private stream: WriteStream | undefined
  /** 活跃档自本次打开以来的写入字节数（size 轮转判定；打开时以盘上真实 size 为起点）。 */
  private bytesWritten = 0
  /** 打开前历史超限弥合只做一次（跨重启字节计数丢失的 stat 弥合，对齐 openMainStream）。 */
  private openedOnce = false
  /** close 已调；后续 append/close 均 no-op。 */
  private ended = false
  /** 异步轮转进行中（end 旧流等 flush → 级联 rename → 开新流 → 回放队列）。 */
  private rotationInFlight: Promise<void> | null = null
  /** 轮转窗口内到达的行（新流就绪后按序回放）。 */
  private readonly pendingLines: Array<{ line: string; bytes: number }> = []
  /** 窗口内超限丢弃计数（轮转结束后合并记一次 warn，不在热路径递归记日志）。 */
  private pendingDroppedCount = 0
  /** 流错误已上报过一次（once 形态，防失败风暴刷主日志）。 */
  private errorReported = false

  constructor(
    private readonly baseFile: string,
    private readonly maxFileBytes: number,
    private readonly dirReady: boolean,
  ) {}

  append(event: CrashJournalEvent): void {
    if (this.ended || !this.dirReady) return
    try {
      // ts 缺省补写入时刻（append 同步即事件产生时刻；显式 null = 调用方声明「不知道」，
      // 展开覆盖语义保留 null 不改写）——评估器（D2）按 ts 窗口计数，无 ts 的行不可判。
      const record: CrashJournalEvent = { ts: event.ts ?? new Date().toISOString(), ...event }
      // JSON.stringify 不产生裸换行（\n 被转义）——单行 JSONL 的逐行可解析性由此保证
      const line = `${JSON.stringify(record)}\n`
      const bytes = Buffer.byteLength(line, 'utf8')
      // 轮转进行中：行统一入队，续体在新流就绪后回放（顺序保持 = 跨段行序守恒）
      if (this.rotationInFlight) {
        this.enqueue(line, bytes)
        return
      }
      // size 轮转（写入字节计数，写前判定）：超阈值 → 异步轮转，本行入队
      if (this.stream && this.bytesWritten + bytes > this.maxFileBytes) {
        void this.rotate()
        this.enqueue(line, bytes)
        return
      }
      if (!this.stream) this.openStream()
      if (!this.stream) return // 打开失败（已记 warn）→ 本行丢弃，不抛
      this.stream.write(line)
      this.bytesWritten += bytes
    // eslint-disable-next-line taste/no-silent-catch -- 序列化异常（如 BigInt 字段）等同步失败面；异步 IO 错误由 error 监听器
    } catch {
      // 记一次 warn。台账 best-effort，不向调用方业务链抛错（schema CrashJournalWriter 契约）。
    }
  }

  async close(): Promise<void> {
    if (this.ended && !this.stream && !this.rotationInFlight) return
    this.ended = true
    // 先等轮转续体完成（窗口内 pending 行回放到新流），再 end 最终流
    if (this.rotationInFlight) await this.rotationInFlight
    const stream = this.stream
    this.stream = undefined
    await endAndAwaitStream(stream, `crash-journal:${this.baseFile}`, reportEndAwaitTimeout)
  }

  /** 轮转窗口入队（容量上限防 fs 挂起时无界膨胀，超限丢弃合并报数）。 */
  private enqueue(line: string, bytes: number): void {
    if (this.pendingLines.length >= MAX_PENDING_LINES) {
      this.pendingDroppedCount++
      return
    }
    this.pendingLines.push({ line, bytes })
  }

  /**
   * 异步轮转：end 旧流并**等待 flush 完成** → 级联 rename → 开新流 → 回放队列。
   *
   * 顺序硬约束（logger.ts 审查 m-6 同源）：必须先等旧流 'close'（全部在途 fs.write
   * 落盘）再 rename——否则在途写落进已改名 inode，段级联覆盖该路径时数据丢失。
   */
  private rotate(): Promise<void> {
    if (this.rotationInFlight) return this.rotationInFlight
    const oldStream = this.stream
    // 状态先行清空：轮转窗口内到达的行统一入队（append 的 rotationInFlight 分支）
    this.stream = undefined
    this.bytesWritten = 0
    this.rotationInFlight = (async () => {
      await endAndAwaitStream(oldStream, `crash-journal-rotation:${this.baseFile}`, reportEndAwaitTimeout)
      this.cascadeSegments()
      this.openStream()
      // 回放轮转窗口内到达的行（续体在微任务队列原子执行，无并发写入插队）
      const pending = this.pendingLines.splice(0)
      const stream = this.stream
      if (stream) {
        for (const p of pending) {
          stream.write(p.line)
          this.bytesWritten += p.bytes
        }
      } else {
        this.pendingDroppedCount += pending.length
      }
      this.rotationInFlight = null
      if (this.pendingDroppedCount > 0) {
        const dropped = this.pendingDroppedCount
        this.pendingDroppedCount = 0
        logger.warn(`[crash-journal] dropped ${dropped} events (pending queue overflow during rotation): ${this.baseFile}`)
      }
    })()
    return this.rotationInFlight
  }

  /**
   * 末 3 段级联：删最旧 `.2` → `.1`→`.2` → 活跃档→`.1`。
   *
   * 逐点容错（首轮轮转时 `.2`/`.1` 不存在是常态）：unlink/rename ENOENT 容错跳过；
   * 活跃档 rename 失败时新流续写原档（仅丢失滚动、数据不丢，对齐 logger.ts 容错语义）。
   */
  private cascadeSegments(): void {
    const [seg1, seg2] = SEGMENT_SUFFIXES.map((s) => `${this.baseFile}${s}`)
    try {
      unlinkSync(seg2)
    // eslint-disable-next-line taste/no-silent-catch -- ENOENT = 首轮/无最旧段常态；unlink 失败不阻塞级联
    } catch {
      // no-op
    }
    try {
      renameSync(seg1, seg2)
    // eslint-disable-next-line taste/no-silent-catch -- ENOENT = 首轮常态；次新段缺位不阻塞顶档滚动
    } catch {
      // no-op
    }
    try {
      renameSync(this.baseFile, seg1)
    // eslint-disable-next-line taste/no-silent-catch -- 顶档滚动失败不阻塞写入；新流续写原档，仅丢失轮转、数据不丢
    } catch {
      // no-op
    }
  }

  /**
   * 打开（或重开）活跃档写流。惰性：首次 append / 轮转后 / 流错误后调用。
   *
   * 首开时若盘上既有档已超阈值（上次运行崩溃未轮转、历史大文件），先同步级联一次——
   * 进程内字节计数不覆盖历史，此 stat 弥合跨重启的 size 上限（对齐 openMainStream；
   * 此刻无流在途，同步 rename 安全）。计数起点取盘上真实 size（与 logger 的 0 起点差
   * 一档余量）：历史未满档续写时，10MB 上限按文件绝对大小判定才不被跨重启突破。
   */
  private openStream(): void {
    const size = statSizeSafe(this.baseFile)
    if (!this.openedOnce) {
      this.openedOnce = true
      if (size > this.maxFileBytes) this.cascadeSegments()
    }
    let stream: WriteStream
    try {
      stream = createWriteStream(this.baseFile, { flags: 'a' })
    } catch {
      // 同步打开失败（非法路径/EMFILE）：归一 undefined 降级，下次 append 重试惰性打开
      this.reportWriteFailure(`stream open failed: ${this.baseFile}`)
      return
    }
    stream.on('error', () => {
      // 异步写错误（磁盘满/权限）：记一次 warn 后置空，下次 append 惰性重开（自愈重建）。
      // once 形态防失败风暴刷主日志（对齐 attachStreamErrorHandler）。
      this.stream = undefined
      this.reportWriteFailure(`write stream error: ${this.baseFile}; further errors suppressed`)
    })
    this.stream = stream
    this.bytesWritten = statSizeSafe(this.baseFile)
  }

  /** 失败上报（writer 级 once：首个失败记主日志 warn，后续静默）。 */
  private reportWriteFailure(message: string): void {
    if (this.errorReported) return
    this.errorReported = true
    reportWriteFailureOnce(message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runtime 侧单例（对齐 logger.ts 既有单例风格：组合根 init + 模块级单例 + 未初始化 no-op）
// ─────────────────────────────────────────────────────────────────────────────

/** runtime 单例（写 runtime.jsonl；D1 双文件的 runtime 半边）。 */
let runtimeSingleton: CrashJournalFileWriter | undefined

/** 未初始化时的 no-op writer（单元测试零副作用，对齐 createPiSessionLog 未初始化契约）。 */
const NOOP_CRASH_JOURNAL: CrashJournalWriter = { append: () => {} }

/**
 * 初始化 runtime 台账单例（组合根 index.ts 最早处调一次，幂等）。
 *
 * @param dataDir 数据根目录；缺省 getDataDir() 动态推导（XYZ_AGENT_DATA_DIR 可覆盖）
 */
export function initCrashJournal(dataDir: string = getDataDir()): CrashJournalWriter {
  runtimeSingleton ??= createCrashJournalWriter({ role: 'runtime', dataDir })
  return runtimeSingleton
}

/** 获取 runtime 台账单例；未初始化时返回 no-op writer。 */
export function getCrashJournal(): CrashJournalWriter {
  return runtimeSingleton ?? NOOP_CRASH_JOURNAL
}

/**
 * 关闭 runtime 台账单例（shutdown 链挂点：等轮转与缓冲 flush 落盘后进程才可退出）。
 * 幂等；close 后 getCrashJournal() 回到 no-op。
 */
export async function closeCrashJournal(): Promise<void> {
  const writer = runtimeSingleton
  runtimeSingleton = undefined
  await writer?.close()
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

function statSizeSafe(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0 // ENOENT = 档不存在常态；其余 IO 错误按 0 降级（best-effort）
  }
}

/**
 * 台账写入失败的唯一出口：记 runtime 主日志一条 warn（logger 显式对象直写文件、不经
 * console patch，与 crash-journal 写失败互不触发递归）。logger 自身写失败由其内部容错。
 * 模块级 once：实例级 once（reportWriteFailure）在其上聚合，防多实例失败风暴刷屏。
 */
let failureReported = false
function reportWriteFailureOnce(message: string): void {
  if (failureReported) return
  failureReported = true
  logger.warn(`[crash-journal] ${message}`)
}

/**
 * endAndAwait 超时的留痕出口（注入共享原语 stream-end-await；对齐 logger 的「非静默
 * 降级」原则——记 error 级日志，超时销毁丢弃的在途缓冲尾部行有人知道）。
 */
function reportEndAwaitTimeout(label: string): void {
  logger.error(`[crash-journal] endAndAwait timeout after ${END_AWAIT_TIMEOUT_MS}ms (${label}); stream force-destroyed`)
}
