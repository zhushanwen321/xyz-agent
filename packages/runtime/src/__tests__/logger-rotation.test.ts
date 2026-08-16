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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// vi.hoisted：mock 工厂在模块 import 期执行，外层 const 尚在 TDZ，须经 hoisted 共享。
const { order, FakeStream } = vi.hoisted(() => {
  class FakeStream {
    file: string
    closed = false
    writableEnded = false
    chunks: string[] = []
    constructor(file: string) {
      this.file = file
    }
    write(data: string | Uint8Array): boolean {
      if (this.writableEnded) return false
      this.chunks.push(String(data))
      return true
    }
    end(): this {
      if (!this.writableEnded) {
        order.push(`end:${this.file}`)
        this.writableEnded = true
        this.closed = true
      }
      return this
    }
    on(): this {
      return this
    }
    once(): this {
      return this
    }
  }
  const order: string[] = []
  return { order, FakeStream }
})

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

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'logger-rot-'))
  order.length = 0
  vi.resetModules()
  delete process.env.XYZ_LOG_MAX_BYTES
})

afterEach(() => {
  delete process.env.XYZ_LOG_MAX_BYTES
  vi.useRealTimers()
})

describe('logger.ts 轮转顺序（fs mock）', () => {
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
})
