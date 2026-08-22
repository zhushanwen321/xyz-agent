/**
 * 跨进程同步文件锁（D1a，integrity-hardening.md §3.1）。
 *
 * 为什么存在：settings.json 等文件被 xyz runtime 与 pi 子进程双写（跨进程 RMW），
 * Node 单线程只能保证进程内不交错，挡不住跨进程的「后写者基于旧快照覆盖先写者」。
 * 本工具用 proper-lockfile 的 lockSync 与对端（pi）互斥同一把锁（同一 lockfile 路径
 * `<目标文件>.lock`，惯例：目标文件路径 + '.lock'）。
 *
 * 为什么是自实现 busy-wait 而不是 retries 参数：proper-lockfile 的 sync API 与
 * retries 组合直接抛 ESYNC（adapter.toSyncOptions 明确禁止），重试必须在外层同步
 * 循环做（R2 审查核实 + /tmp/w1-probe 探针再证）。
 *
 * 为什么 sleep 用 Atomics.wait：真 sleep 不烧 CPU（pi 侧 acquireLockSyncWithRetry
 * 用 CPU 自旋，源码原样；两种等待对互斥语义等价，只影响 CPU 占用）。
 *
 * 契约：
 *   - fn 内禁止任何 I/O / await / 再次对本文件加锁（同步上下文无 event loop，
 *     嵌套取锁必然 ELOCKED → 重试预算耗尽 → fail-fast）。持锁范围应仅为
 *     「读文件 + 纯内存变更 + 原子写」，毫秒级。
 *   - 预算耗尽 fail-fast 抛错（对齐 pi 放弃保存的语义），不静默不重排队——
 *     同步 busy-wait 阻塞整个 event loop，预算必须被严格限制在 ~1s 量级。
 *
 * 归属：跨层共享叶子层 utils/（与 json-store 同层），无业务语义，可被
 * settings.json / ext-config 等任何跨进程共享文件复用（须登记锁协议，
 * 见 docs/architecture/data-source-registry.md 跨进程文件登记表）。
 *
 * 孪生实现：extension 侧 @zhushanwen/pi-file-lock（extensions/shared/file-lock/
 * src/file-lock.ts，async 版 + sync 版，D5a/D1e）——其中 sync 版与本模块是同一协议的
 * 两侧实现，默认参数（stale 30s / retry 25ms / 预算 1s）必须一致，**参数变更须双侧
 * 同步**；对照测试 test/file-lock-parity.test.ts 断言两侧默认值相等。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'

export interface SyncFileLockOptions {
  /** 锁 mtime 超过该值视为持锁者已死可夺取（stale 语义）。默认 30_000ms。 */
  staleMs?: number
  /** ELOCKED 重试间隔（同步 sleep）。默认 25ms。 */
  retryDelayMs?: number
  /** ELOCKED 重试总预算，耗尽 fail-fast。默认 1_000ms。 */
  retryBudgetMs?: number
}

/**
 * 默认锁参数（导出供对照测试断言与 extension 侧孪生实现 @zhushanwen/pi-file-lock
 * 的 sync 版默认值相等——两侧参数漂移会破坏「同一把锁」的互斥语义）。
 */
export const DEFAULT_STALE_MS = 30_000
export const DEFAULT_RETRY_DELAY_MS = 25
export const DEFAULT_RETRY_BUDGET_MS = 1_000

/**
 * 同步跨进程文件锁内执行 fn：lockSync(realpath:false) + ELOCKED busy-wait 重试，
 * 预算耗尽抛带 ELOCKED code 的错误；unlock 放 finally（fn 抛错也释放）。
 *
 * realpath:false —— 目标文件不存在也可锁（realpath 默认 true 时 ENOENT 拿不到锁），
 * 与 pi 侧 lockSync 参数一致；锁前确保父目录存在（mkdir lockfile 需要）。
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, opts?: SyncFileLockOptions): T {
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const retryBudgetMs = opts?.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS

  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const deadline = Date.now() + retryBudgetMs
  let release: (() => void) | undefined
  while (release === undefined) {
    try {
      release = lockfile.lockSync(filePath, { realpath: false, stale: staleMs })
    } catch (err) {
      if (!isElocked(err)) throw err
      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error(
            `[file-lock] ${filePath} 写锁获取失败：ELOCKED 重试预算 ${retryBudgetMs}ms 耗尽` +
            `（持锁方临界区异常或已崩溃，stale ${staleMs}ms 后可夺取）。恢复指引：稍后重试本次写入。`,
            { cause: err },
          ),
          { code: 'ELOCKED' },
        )
      }
      sleepSync(retryDelayMs)
    }
  }
  try {
    return fn()
  } finally {
    release()
  }
}

function isElocked(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ELOCKED'
}

// ──────────────────────── async 版（auth.json / providers.json 写锁共用） ────────────────────────

export interface AsyncFileLockOptions {
  /** 锁前保证目标文件存在（proper-lockfile realpath 需要）——调用方声明各自的初始化语义。 */
  ensure: () => void
  /** release 失败 warn 的日志前缀（如 'auth-storage' / 'provider-extras-store'）。 */
  logTag: string
}

/**
 * 跨进程异步文件锁：proper-lockfile lock（retries 10/factor 2/minTimeout 100/
 * maxTimeout 10s/randomize + stale 30s + onCompromised 延迟抛出），参数对齐
 * pi FileAuthStorageBackend.withLockAsync（与 pi 侧刷新写回互斥同一把锁）。
 * 锁协议单点维护——auth-storage 与 provider-extras-store 共用，勿在调用方复制参数。
 */
export async function withFileLockAsync<T>(
  filePath: string,
  opts: AsyncFileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  opts.ensure()
  // onCompromised：锁被判定 stale 抢占（进程卡死超时等）时标记，fn 执行前抛错，
  // 防止在失去互斥保证的锁下写盘（对齐 pi throwIfCompromised 语义）。
  let compromised: Error | undefined
  const release = await lockfile.lock(filePath, {
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 10_000,
      randomize: true,
    },
    stale: 30_000,
    onCompromised: (err) => { compromised = err },
  })
  try {
    if (compromised) throw compromised
    return await fn()
  } finally {
    try {
      await release()
    } catch (error) {
      // 锁已 compromised 时 unlock 失败可忽略（对齐 pi finally 的 catch 语义）——
      // 记 warn 而非静默：compromised 之外的原因（lock 文件被外部删等）需要可观测
      console.warn(`[${opts.logTag}] release lock failed (continuing, lock may be compromised):`, error)
    }
  }
}

/** Atomics.wait 需要一个共享内存对象作等待目标；4 字节 = 一个 Int32 元素，仅占位不被写入。 */
const SLEEP_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_WAIT_BUFFER, 0, 0, ms)
}
