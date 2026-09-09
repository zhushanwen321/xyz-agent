/**
 * renderer-log-handler 单测（crash-resilience u2-renderer-errors 验收条款）。
 *
 * 覆盖：
 * - windowId 限流：100 条/窗口全落盘、超限丢弃、窗口翻转落汇总行（含 dropped count）
 * - 限流跨窗口独立（不同 webContents id 互不影响）
 * - 落盘行格式：紧凑 JSON 行含时间戳/栈/windowId；多行栈折叠单行（JSON 转义）；
 *   windowId 取 event.sender.id（main 权威），payload 自报不采信；sessionId/memory 透传
 * - handler 零抛错：畸形 payload / event 缺失 / 落盘目标不可写（EISDIR）均不外抛
 *
 * 全部夹具 mkdtempSync(tmpdir) 自建自删（fs-guard 生效中，写目标 =
 * $XYZ_AGENT_DATA_DIR 白名单）；electron mock 捕获 ipcMain.handle（对齐
 * test/privileged-handlers.test.ts 形态）；限流窗口推进用 fake Date（IO 保持真实）。
 * 运行：cd apps/electron/main && npx vitest run logs/__tests__/renderer-log-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 捕获注册的 handler（key=channel, value=handler fn），由 ipcMain.handle 桩写入
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

/** handler 落盘记录形态（JSON 行反序列化后的最小断言面）。 */
interface ErrorLine {
  ts: string
  windowId: number
  source?: string
  message?: string
  stack?: string
  sessionId?: string
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
  kind?: string
  dropped?: number
  url?: string
}

const SENDER_ID = 42

/** 构造 invoke event 桩（sender.id 数字 = main 权威 windowId；senderFrame.url 取证字段）。 */
function makeEvent(senderId = SENDER_ID, url?: string) {
  return {
    sender: { id: senderId },
    senderFrame: url === undefined ? undefined : { url },
  }
}

/** 合法 payload 工厂（可覆写字段）。 */
function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    source: 'vue-error-handler',
    message: 'boom',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('renderer-log-handler', () => {
  let tmpDir: string
  let savedDataDir: string | undefined

  /** 动态 import 拿当前模块实例（vi.resetModules 后限流 Map 为全新状态）。 */
  async function loadHandler() {
    return await import('../renderer-log-handler.js')
  }

  /** 读取当天 renderer-error 日志并按行反序列化（末尾空行剔除）。 */
  function readLines(): ErrorLine[] {
    const today = new Date().toISOString().slice(0, 10)
    const file = join(tmpDir, 'logs', `renderer-error-${today}.log`)
    expect(existsSync(file), `log file should exist at ${file}`).toBe(true)
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as ErrorLine)
  }

  beforeEach(() => {
    vi.resetModules()
    handlers.clear()
    tmpDir = mkdtempSync(join(tmpdir(), 'renderer-log-handler-test-'))
    savedDataDir = process.env.XYZ_AGENT_DATA_DIR
    process.env.XYZ_AGENT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.XYZ_AGENT_DATA_DIR
    else process.env.XYZ_AGENT_DATA_DIR = savedDataDir
    vi.useRealTimers()
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('限流：同窗口 100 条全落盘，101-120 条丢弃，窗口翻转后落汇总行（含 dropped count）', async () => {
    const { handleRendererLogReport } = await loadHandler()
    const event = makeEvent()
    for (let i = 0; i < 120; i++) {
      handleRendererLogReport(event, makePayload({ message: `err-${i}` }))
    }
    let lines = readLines()
    expect(lines).toHaveLength(100) // 101-120 被限流丢弃
    expect(lines[99].message).toBe('err-99')

    // 推进 61s：下一条先触发上一窗口汇总行（dropped=20），随后新窗口正常落盘
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 })
    handleRendererLogReport(event, makePayload({ message: 'next-window' }))
    lines = readLines()
    const summary = lines.find((l) => l.kind === 'rate-limit-summary')
    expect(summary).toBeDefined()
    expect(summary?.dropped).toBe(20)
    expect(summary?.windowId).toBe(SENDER_ID)
    expect(summary?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(lines.filter((l) => l.kind === undefined)).toHaveLength(101)
    expect(lines[lines.length - 1].message).toBe('next-window')
  })

  it('限流跨窗口独立：窗口 A 打满不影响窗口 B 落盘', async () => {
    const { handleRendererLogReport } = await loadHandler()
    const winA = makeEvent(1)
    const winB = makeEvent(2)
    for (let i = 0; i < 100; i++) handleRendererLogReport(winA, makePayload({ message: `a-${i}` }))
    handleRendererLogReport(winB, makePayload({ message: 'b-untouched' }))
    const lines = readLines()
    expect(lines.filter((l) => l.windowId === 1)).toHaveLength(100)
    expect(lines.filter((l) => l.windowId === 2)).toHaveLength(1)
    expect(lines.some((l) => l.message === 'b-untouched')).toBe(true)
  })

  it('落盘行格式：紧凑 JSON 行含时间戳/栈/windowId；多行栈折叠单行；payload 自报 windowId 不采信', async () => {
    const { handleRendererLogReport } = await loadHandler()
    handleRendererLogReport(
      makeEvent(SENDER_ID, 'http://localhost:1420/'),
      makePayload({
        message: 'render exploded',
        stack: 'Error: render exploded\n    at Foo.vue:1:1\n    at main.ts:2:2',
        sessionId: 'sess-abc',
        windowId: 'self-reported-should-be-ignored', // renderer 自报，必须被 main 权威值覆盖
        memory: { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 },
      }),
    )
    const raw = readFileSync(
      join(tmpDir, 'logs', `renderer-error-${new Date().toISOString().slice(0, 10)}.log`),
      'utf-8',
    )
    // 栈含 2 个 \n：折叠为单行——文件恰好 1 行（紧凑 JSON 行 = 多行折叠）
    expect(raw.trim().split('\n')).toHaveLength(1)
    const line = JSON.parse(raw) as ErrorLine
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    expect(line.windowId).toBe(SENDER_ID) // main 权威（webContents id），非自报
    expect(line.source).toBe('vue-error-handler')
    expect(line.message).toBe('render exploded')
    expect(line.stack).toContain('at Foo.vue:1:1')
    expect(line.sessionId).toBe('sess-abc')
    expect(line.memory).toEqual({ usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 })
    expect(line.url).toBe('http://localhost:1420/')
  })

  it('memory 不可用时字段省略（P-mem-api 降级形态）；stack/sessionId 可选字段缺省不落 null', async () => {
    const { handleRendererLogReport } = await loadHandler()
    handleRendererLogReport(makeEvent(), makePayload())
    const line = readLines()[0]
    expect(line.memory).toBeUndefined()
    expect(line.stack).toBeUndefined()
    expect(line.sessionId).toBeUndefined()
    expect(JSON.stringify(line)).not.toContain(':null')
  })

  it('handler 零抛错：畸形 payload / event 缺失 / 落盘目标 EISDIR 均不外抛', async () => {
    const { handleRendererLogReport, registerRendererLogHandler } = await loadHandler()
    // 畸形 payload（不可信输入）
    expect(() => handleRendererLogReport(makeEvent(), null)).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), undefined)).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), 'not-an-object')).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), { source: 'bad-source', message: 'x', timestamp: 1 })).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), { source: 'vue-error-handler', message: '', timestamp: 1 })).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), { source: 'vue-error-handler', message: 'x', timestamp: 'bad' })).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), { source: 'vue-error-handler', message: 'x', timestamp: 1, memory: { usedJSHeapSize: 'bad' } })).not.toThrow()
    expect(() => handleRendererLogReport(undefined, makePayload())).not.toThrow()
    // event 缺 sender.id
    expect(() => handleRendererLogReport({ sender: {} }, makePayload())).not.toThrow()
    // 落盘目标位置是目录 → appendFileSync EISDIR 也不外抛
    // （fake Date 切到未来日期：EISDIR 目标与前面用例写入的当天文件不同名，避免 mkdir EEXIST）
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-01T00:00:00Z') })
    mkdirSync(join(tmpDir, 'logs'), { recursive: true })
    mkdirSync(join(tmpDir, 'logs', `renderer-error-2030-01-01.log`))
    expect(() => handleRendererLogReport(makeEvent(), makePayload())).not.toThrow()
    // 注册路径不抛（重复注册幂等不炸）
    expect(() => registerRendererLogHandler()).not.toThrow()
    expect(() => registerRendererLogHandler()).not.toThrow()
    expect(handlers.has('renderer-log')).toBe(true)
  })

  it('registerRendererLogHandler 经 ipcMain.handle 注册 RENDERER_LOG 通道，invoke 链路可落盘', async () => {
    const { registerRendererLogHandler } = await loadHandler()
    registerRendererLogHandler()
    const fn = handlers.get('renderer-log')
    expect(fn).toBeTypeOf('function')
    expect(() => fn?.(makeEvent(), makePayload({ message: 'via-ipc' }))).not.toThrow()
    expect(readLines().some((l) => l.message === 'via-ipc')).toBe(true)
  })
})
