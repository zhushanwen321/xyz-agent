/**
 * async-mutex —— per-key 串行化 async 函数的基础设施（P6 D1）。
 *
 * 设计来源：.xyz-harness/2026-07-26-remote-p6/spec.md §3.1（D1 决策）。
 *
 * 职责：
 * - createKeyedMutex() 返回 { run }，同 key 的 async fn 串行执行（第二个等第一个完成），
 *   不同 key 并发执行互不阻塞。
 * - run 可选 timeoutMs：排队等待超过阈值抛 TimeoutError（fn 未执行），由调用方捕获转 *_busy。
 * - 无排队时 Map 条目自动删除防泄漏。
 *
 * 自实现不引第三方库（D1）：需求简单（per-key 串行队列 + 超时 + 清理），自实现 < 60 行。
 * 第三方库（async-mutex）的价值（可取消/优先级/条件变量）本场景用不到，且引入需同步加
 * tsup noExternal（架构约定 #12）。
 *
 * 实现原理（Promise chain 串行化）：
 * - chains: Map<key, MutexChain>，每个 chain 持有其尾部 promise（下一个 run 要 await 的）。
 * - run 时取 prev = chains.get(key)?.promise ?? Promise.resolve()，构造 next = new Promise，
 *   把 next 设为该 key 的新尾部；await prev（即等前一个 fn 完成）后再执行 fn。
 * - finally 块 resolveChain（推进 chain，无论 fn 成功/失败），并清理 Map（若当前 chain 还是
 *   next 表示无人排队，删 key 防泄漏）。
 *
 * 不变量：
 * - resolveChain 必须在 finally 调用（fn 抛错也推进 chain，否则后续永久阻塞——SR1）。
 * - 超时只在 await prev 阶段 race（排队拒绝），fn 执行阶段不 race（git spawn 不可中断）。
 */

/**
 * run 排队超时时抛出（D11）。
 * 调用方（git-message-handler / worktree-message-handler）用 instanceof 判断转 reply error
 * code git_busy / worktree_busy。
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** per-key mutex 的对外契约。 */
export interface KeyedMutex {
  /**
   * 串行执行同 key 的 async fn。
   * @param key 资源标识（如 cwd / `${cwd}:${branch}`）
   * @param fn 要串行执行的 async 函数
   * @param timeoutMs 排队等待超时阈值（不传则无限等待）。超时抛 TimeoutError，fn 不执行。
   * @returns fn 的返回值
   */
  run<T>(key: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>
  /**
   * 测试钩子：暴露内部 chains Map 供泄漏测试断言（`chains.get(key) === undefined` 等）。
   * 非公共 API，仅用于单测验证「无排队时 Map 自动清理」不变量；生产代码不应调用。
   */
  readonly _chainsForTest: Map<string, MutexChain>
}

/** 内部：每个 key 的 chain 尾部 promise（下一个 run 要 await 的）。 */
interface MutexChain {
  promise: Promise<unknown>
}

/**
 * 创建一个 per-key 串行化 mutex（D1）。
 *
 * 返回的 { run } 对同 key 的调用串行化（第二个等第一个），不同 key 互不阻塞。
 * 实例间隔离（各自独立 chains Map）。
 */
export function createKeyedMutex(): KeyedMutex {
  const chains = new Map<string, MutexChain>()

  async function run<T>(key: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const prev = chains.get(key)?.promise ?? Promise.resolve()
    let resolveChain: () => void
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- Promise 构造器要求 executor，resolveChain 在 finally 调用
    const next = new Promise<void>((resolve) => { resolveChain = resolve })
    chains.set(key, { promise: next })

    try {
      // 排队等待阶段：await prev（等前一个 fn 完成）。可选 race 超时（D11）。
      // 超时只在等待阶段——fn 开始执行后不再 race（git spawn 不可中断，等其自然完成）。
      if (timeoutMs !== undefined) {
        // Promise.race：prev 先 resolve（前一个完成）则继续；超时 promise 先 reject 则抛 TimeoutError。
        // 不用 Promise.all（项目禁用）；race 是单值竞速，符合「谁先 settle 谁赢」语义。
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new TimeoutError(`mutex run timed out after ${timeoutMs}ms waiting for key: ${key}`)), timeoutMs)
        })
        await Promise.race([prev, timeout])
      } else {
        await prev
      }
      // fn 执行阶段：prev 已完成（chain 轮到当前），执行 fn。fn 的 reject 原样传播（不吞错）。
      return await fn()
    } finally {
      // resolveChain 推进 chain（无论 fn resolve/reject/超时，下一个排队者不再 await 已完成的 prev）。
      resolveChain!()
      // 清理：若当前 chain 还是 next（无人排队），删 key 防泄漏。
      // 若已有下一个排队者写入 next2，chains.get(key).promise === next2 ≠ next，此处不删——
      // 但 Map 持有的是 next2（不是 next），next 仅有本 run 引用，resolve 后即可 GC，不泄漏。
      // 关键不变量：Map 永远只持有「最新尾部 promise」（最后一个排队者的 next），
      // 该尾部最终由其 owner run 的 finally 清理（owner 完成时再次 === 判断命中 delete）。
      if (chains.get(key)?.promise === next) chains.delete(key)
    }
  }

  return { run, _chainsForTest: chains }
}
