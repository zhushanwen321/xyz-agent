/**
 * logger.ts 轮转顺序测试（perf W30 / 06 §3.3 D10-1 审查 m-6）——fs mock 断言调用序。
 *
 * 硬约束：size 轮转必须「end 旧流 → rename → 开新流」——rename 时若流仍持旧 inode，
 * 继续 write 会写进已改名文件（macOS 允许、Windows 失败）；end 先行使旧流不再接收写入。
 * 跨天轮转：end 旧日期流 → 惰性开新日期流（按日期命名天然隔离，无 rename）。
 *
 * 用 vi.mock('node:fs') 替换 createWriteStream / renameSync，以共享 order 数组断言调用
 * 顺序；statSync mock 恒返回 {size:0}（真实磁盘上文件不存在——createWriteStream 被 mock，
 * 轮转的存在性门控需放行）；其余 fs 方法保留真实实现（mkdtempSync 建真实临时目录）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWriteStream, mkdtempSync, type WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// vi.hoisted：mock 工厂在模块 import 期执行，外层 const 尚在 TDZ，须经 hoisted 共享。
const { order, FakeStream } = vi.hoisted(() => {
  class FakeStream {
    file: string
    closed = false
    writableEnded = false
    destroyed = false
    chunks: string[] = []
    /**
     * close 时机模式（审查 W30 Fix-3：验证顺序约束真正依赖 close 等待，而非假同步）：
     * 0 = end 同步置 closed（默认，既有测试路径）；>0 = end 后延迟 N tick 才置 closed
     * 并 emit 'close'（模拟真实流的异步 flush）；-1 = 永不 close（超时降级路径用）。
     */
    closeDelayTicks = 0
    private handlers: Record<string, Array<() => void>> = {}
    constructor(file: string) {
      this.file = file
    }
    write(data: string | Uint8Array): boolean {
      if (this.writableEnded) return false
      this.chunks.push(String(data))
      return true
    }
    /** endAndAwait 超时降级路径会强制销毁流（审查 W30 Fix-1）——fake 必须忠实模拟该 API。 */
    destroy(): this {
      this.destroyed = true
      this.closed = true
      return this
    }
    on(evt: string, fn: () => void): this {
      ;(this.handlers[evt] ??= []).push(fn)
      return this
    }
    once(evt: string, fn: () => void): this {
      const wrapped = () => {
        this.off(evt, wrapped)
        fn()
      }
      ;(this.handlers[evt] ??= []).push(wrapped)
      return this
    }
    off(evt: string, fn: () => void): this {
      const arr = this.handlers[evt]
      if (arr) this.handlers[evt] = arr.filter((h) => h !== fn)
      return this
    }
    // endAndAwait 清理 once 链用 removeListener（EventEmitter 同名 API）
    removeListener(evt: string, fn: () => void): this {
      return this.off(evt, fn)
    }
    emit(evt: string): void {
      for (const h of [...(this.handlers[evt] ?? [])]) h()
    }
    end(): this {
      if (!this.writableEnded) {
        order.push(`end:${this.file}`)
        this.writableEnded = true
        if (this.closeDelayTicks === 0) {
          this.closed = true
        } else if (this.closeDelayTicks > 0) {
          let remaining = this.closeDelayTicks
          const loop = () => {
            remaining -= 1
            if (remaining <= 0) {
              this.closed = true
              this.emit('close')
            } else {
              setImmediate(loop)
            }
          }
          setImmediate(loop)
        }
        // closeDelayTicks < 0：永不 close（endAndAwait 超时降级测试路径）
      }
      return this
    }
  }
  const order: string[] = []
  return { order, FakeStream }
})

/**
 * FakeStream 是行为子集替身（end/close 时序 + chunks 记录），无法结构化实现 fs.WriteStream
 * 全接口（27+ 成员）——行为契约由各用例的调用序/内容断言保证，而非类型系统。测试替身
 * cast 是项目既有惯例（message-broker-appinfo.test.ts 等同款）。
 */
function asWriteStream(s: InstanceType<typeof FakeStream>): WriteStream {
  return s as unknown as WriteStream
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    createWriteStream: vi.fn((file: string) => {
      order.push(`open:${file}`)
      return new FakeStream(file)
    }),
    renameSync: vi.fn((from: string, to: string) => {
      order.push(`rename:${from}->${to}`)
    }),
    statSync: vi.fn(() => ({ size: 0 })), // 磁盘文件不存在（createWriteStream 被 mock）→ 存在性门控放行
  }
})

let dataDir: string

/** logger 模块 import 时读取的全部 env（保存/恢复隔离测试间与外部进程污染，审查 W30 Fix-6）。 */
const LOG_ENV_KEYS = ['XYZ_LOG_MAX_BYTES', 'XYZ_LOG_KEEP_DAYS', 'XYZ_LOG_LEVEL'] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'logger-rot-'))
  order.length = 0
  savedEnv = Object.fromEntries(LOG_ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const key of LOG_ENV_KEYS) delete process.env[key]
  vi.resetModules()
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.useRealTimers()
})

describe('logger.ts 轮转顺序（fs mock）', () => {
  /** 让事件循环转一圈（FakeStream 的延迟 close 按 setImmediate tick 计数）。 */
  function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
  }

  it('size 轮转：end 旧流 → rename → 开新流（审查 m-6 顺序硬约束）', async () => {
    process.env.XYZ_LOG_MAX_BYTES = '80' // 单行 ~36B → 每 ~2 行触发一次 size 轮转
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    for (let i = 0; i < 10; i++) logger.logger.info(`line-${i}`)
    await logger.closeLogger()

    const opens = order.filter((o) => o.startsWith('open:'))
    const renames = order.filter((o) => o.startsWith('rename:'))
    expect(renames.length).toBeGreaterThanOrEqual(1) // 字节计数轮转确实触发
    expect(opens.length).toBeGreaterThanOrEqual(2) // 轮转后重开新流

    // 每个 rename 紧邻前件是 end（旧流先关）、后件是 open（新流再开）——
    // 任何「rename 后旧流仍可写」的实现都会破坏此序列
    for (let i = 0; i < order.length; i++) {
      if (order[i].startsWith('rename:')) {
        expect(order[i - 1]).toMatch(/^end:/)
        expect(order[i + 1]).toMatch(/^open:/)
      }
    }
  })

  it('跨天轮转：end 旧日期流 → 开新日期流（无 rename，旧日期文件保留）', async () => {
    // 默认 50MB 阈值：跨天场景不应被 size 轮转干扰
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T10:00:00Z'))
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    logger.logger.info('day-1')
    vi.setSystemTime(new Date('2026-08-02T10:00:00Z'))
    logger.logger.info('day-2')
    await logger.closeLogger()

    expect(order.filter((o) => o.startsWith('rename:'))).toHaveLength(0)
    expect(order).toEqual([
      expect.stringMatching(/^open:.*runtime-2026-08-01\.log$/),
      expect.stringMatching(/^end:.*runtime-2026-08-01\.log$/),
      expect.stringMatching(/^open:.*runtime-2026-08-02\.log$/),
      expect.stringMatching(/^end:.*runtime-2026-08-02\.log$/),
    ])
  })

  it('异步 close 顺序约束：close 未完成期间 rename 不提前发生（审查 W30 Fix-3）', async () => {
    process.env.XYZ_LOG_MAX_BYTES = '80'
    let first = true
    vi.mocked(createWriteStream).mockImplementation((file) => {
      const name = String(file) // 签名参数为 PathLike（URL 兼容），FakeStream 构造器收 string
      order.push(`open:${name}`)
      const s = new FakeStream(name)
      if (first) {
        first = false
        s.closeDelayTicks = 3 // 首个流 end 后延迟 3 tick 才 close（模拟真实流的异步 flush）
      }
      return asWriteStream(s)
    })
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    for (let i = 0; i < 6; i++) logger.logger.info(`line-${i}`)
    // init 行已超阈值 → 轮转已触发：end 已调用，但 close 延迟未完成 → rename 不得发生
    const beforeClose = [...order]
    expect(beforeClose.filter((o) => o.startsWith('end:'))).toHaveLength(1)
    expect(beforeClose.filter((o) => o.startsWith('rename:'))).toHaveLength(0)
    // 推进到 close 完成 → rename 才发生（顺序约束真正依赖 close 等待，而非假同步）
    await tick()
    await tick()
    await tick()
    const afterClose = [...order]
    const renames = afterClose.filter((o) => o.startsWith('rename:'))
    expect(renames).toHaveLength(1)
    // rename 严格位于 end 之后（close 完成后才发生）
    const endIdx = afterClose.findIndex((o) => o.startsWith('end:'))
    expect(afterClose.findIndex((o) => o.startsWith('rename:'))).toBeGreaterThan(endIdx)
    await logger.closeLogger()
  })

  it('endAndAwait 超时降级：close 永不触发时超时后 resolve，强制销毁流 + 记 error，轮转不永久挂起（审查 W30 Fix-1）', async () => {
    vi.useFakeTimers()
    process.env.XYZ_LOG_MAX_BYTES = '80'
    const created: InstanceType<typeof FakeStream>[] = []
    let first = true
    vi.mocked(createWriteStream).mockImplementation((file) => {
      const name = String(file)
      order.push(`open:${name}`)
      const s = new FakeStream(name)
      if (first) {
        first = false
        s.closeDelayTicks = -1 // 永不 close：模拟 fs 挂起（'close' 永不触发）
      }
      created.push(s)
      return asWriteStream(s)
    })
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    for (let i = 0; i < 6; i++) logger.logger.info(`line-${i}`)
    // 轮转已触发且 end 已调用，但 close 永不触发 → 无超时前 rename 不得发生
    expect(order.filter((o) => o.startsWith('end:'))).toHaveLength(1)
    expect(order.filter((o) => o.startsWith('rename:'))).toHaveLength(0)
    // 推进超过 END_AWAIT_TIMEOUT_MS（5s）→ 超时降级：强制销毁挂起流 + 记 error 级日志
    await vi.advanceTimersByTimeAsync(6000)
    expect(created[0].destroyed).toBe(true) // 挂起流被强制销毁（fd 不悬挂）
    // error 报告入 pendingLines 队列（超时时轮转仍在进行），回放后落进新流
    const allChunks = created.flatMap((s) => s.chunks).join('')
    expect(allChunks).toContain('[ERROR]')
    expect(allChunks).toContain('endAndAwait timeout')
    expect(order.filter((o) => o.startsWith('rename:'))).toHaveLength(1) // rename 照常发生（数据不丢）
    await logger.closeLogger()
  })

  it('pendingLines 容量上限：轮转窗口超长时超限行丢弃并合并 warn 一次（审查 W30 Fix-1）', async () => {
    vi.useFakeTimers()
    process.env.XYZ_LOG_MAX_BYTES = '80'
    const created: InstanceType<typeof FakeStream>[] = []
    let first = true
    vi.mocked(createWriteStream).mockImplementation((file) => {
      const name = String(file)
      order.push(`open:${name}`)
      const s = new FakeStream(name)
      if (first) {
        first = false
        s.closeDelayTicks = -1 // 永不 close：轮转窗口保持打开，pending 队列持续累积
      }
      created.push(s)
      return asWriteStream(s)
    })
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    // init 行已超阈值 → 第 0 行起触发轮转；后续全部进 pendingLines（上限 10_000）
    for (let i = 0; i < 10005; i++) logger.logger.info(`line-${i}`)
    // 推进超时：轮转降级完成 → 回放 10_000 行 + 超限丢弃合并记一次 warn。
    // 丢弃计数 = 5（line-10000..10004）+ 1（超时 error 报告自身入队时队列已满被丢，
    // 计入同一计数——error 报告不绕过上限，stderr 出口兜底其可见性）。
    await vi.advanceTimersByTimeAsync(6000)
    logger.logger.info('after-rotation') // 回放使字节计数超阈值 → 再触发一轮轮转（回放是微任务，closeLogger 会 await）
    await logger.closeLogger()
    // warn 只出现一次（含丢弃计数）
    const warnChunks = created.flatMap((s) => s.chunks).filter((c) => c.includes('[WARN]'))
    expect(warnChunks).toHaveLength(1)
    expect(warnChunks[0]).toContain('dropped 6 log lines')
    // 队列内（未超限）的行回放落盘；超限行 line-10000 被丢弃；轮转结束后写入恢复正常
    const allChunks = created.flatMap((s) => s.chunks).join('')
    expect(allChunks).toContain('line-9999')
    expect(allChunks).not.toContain('line-10000')
    expect(allChunks).toContain('after-rotation')
  })
})
