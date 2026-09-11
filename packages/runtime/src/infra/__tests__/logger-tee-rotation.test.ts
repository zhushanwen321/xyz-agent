/**
 * pi stdout tee 单文件 size 轮转测试（crash-forensics-and-watchdog §3.3 D7，单元 u9）。
 *
 * 收口 198MB 实证问题（持续活跃 session 单文件无界累积）的行为验证，用 opts.maxBytes
 * 注入小阈值（生产默认 50MB 不经 env，测试无需改全局旋钮）：
 * 1. 超限旋段：`.jsonl` → `.jsonl.1` 单代滚动，保留末 2 段（更多轮转后旧段被覆盖）
 * 2. `pi-` 前缀不变量：旋段文件名保持 pi- 开头——cleanExpiredLogs 白名单只认顶层
 *    pi-* 前缀，旋段逃出白名单 = 新的无清理写入面（架构 D6③ 原文约束）
 * 3. 跨段行级连续：.1 旧段 + 主档拼接行序连续无缺行（轮转边界无在途写丢失）
 * 4. 尾部 flush 走新流：轮转完成后写入的尾部行经 closeLogger 落在新主档（A5 通过标准，
 *    openPiStreams 注册表 stream 引用轮转后更新）
 * 5. relay 形态同款：createPiRelayLog（D7 复刻点③ `pi-relay-*` 同款，与 session tee
 *    共享 createPiStreamWriter）
 * 6. 打开时预滚：磁盘既有文件已超阈值（跨重启/自愈场景，进程内字节计数不覆盖历史
 *    字节）→ 首次打开先滚动一次再续写
 *
 * 真实 fs + mkdtempSync 自建自删目录（fs-guard 白名单合规，禁止触碰真实数据目录）；
 * 模块级单例经 vi.resetModules + 动态 import 每用例拿新实例；写流 flush 是异步的，
 * 断言前轮询等待（对齐 test/logger.test.ts 既有形态）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type LoggerModule = typeof import('../logger.js')

let logger: LoggerModule | undefined
let dataDir: string
let logsDirPath: string
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug,
}
/** logger 模块 import 时读取的全部 env 快照（beforeEach 保存 / afterEach 恢复）。 */
const LOG_ENV_KEYS = ['XYZ_LOG_MAX_BYTES', 'XYZ_LOG_KEEP_DAYS', 'XYZ_LOG_LEVEL'] as const
let savedEnv: Record<string, string | undefined>

/** 让事件循环转一圈：WriteStream 异步 fd open / flush / close 在 tick 间完成（生产节奏）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 写入后等两个 tick：让在途 flush 完成，下一行写入前轮转窗口已收敛（确定性）。 */
async function settleWrite(): Promise<void> {
  await tick()
  await tick()
}

/** 轮询直到 predicate 为真（写流 flush / 异步轮转续体落盘时机不定，固定 sleep 不可靠）。 */
async function waitFor(desc: string, predicate: () => boolean, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      if (predicate()) return
    } catch { /* 目录/文件尚未就绪，继续轮询 */ }
    if (Date.now() >= deadline) throw new Error(`waitFor timeout (${deadlineMs}ms): ${desc}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** logs 目录下文件名含 marker 的全部条目（排序；main 日志 runtime-* 不含 sid marker 天然排除）。 */
function filesWithMarker(marker: string): string[] {
  return readdirSync(logsDirPath).filter((f) => f.includes(marker)).sort()
}

/** 按行提取 JSON 行内 "i":N 序号（行级连续性断言用）。 */
function extractIndices(content: string): number[] {
  const numbers: number[] = []
  for (const line of content.trim().split('\n')) {
    const m = line.match(/"i":(\d+)/)
    if (m) numbers.push(Number(m[1]))
  }
  return numbers
}

beforeEach(() => {
  vi.resetModules()
  dataDir = mkdtempSync(join(tmpdir(), 'logger-tee-rot-'))
  logsDirPath = join(dataDir, 'logs')
  savedEnv = Object.fromEntries(LOG_ENV_KEYS.map((k) => [k, process.env[k]]))
  // 屏蔽测试中 console 的终端输出（initLogger 会 monkey-patch console）
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  console.info = () => {}
  console.debug = () => {}
})

afterEach(async () => {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.info = originalConsole.info
  console.debug = originalConsole.debug
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // 未显式 close 的测试在此兜底收尾；已 close 的重复调用幂等（closeLogger 后写入为 no-op）
  await logger?.closeLogger().catch(() => {})
  // maxRetries 对齐 test/logger.test.ts 先例：与刚 close 的真实写流在途 flush 竞争时重试删除
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('pi tee size 轮转（D7，u9）', () => {
  it('超限旋段：单代 .1 滚动保留末 2 段，pi- 前缀保持，跨段行级连续止于尾行', async () => {
    logger = await import('../logger.js')
    logger.initLogger(dataDir)
    const sid = 'rot-sid-1'
    const sessionLog = logger.createPiSessionLog(sid, { maxBytes: 200 })
    // 每行 ~28B，200B 阈值 → 多次轮转；单代滚动下早期段被覆盖，幸存的 .1 + 主档 = 末 2 段
    for (let i = 0; i < 40; i++) {
      sessionLog.write(JSON.stringify({ i, pad: 'x'.repeat(10) }))
      await settleWrite()
    }
    sessionLog.end()
    await logger.closeLogger()

    const files = filesWithMarker(sid)
    const rolled = files.filter((f) => f.endsWith('.jsonl.1'))
    const main = files.filter((f) => f.endsWith('.jsonl') && !f.endsWith('.1'))
    expect(rolled.length).toBeGreaterThanOrEqual(1) // 字节计数轮转确实触发
    expect(main).toHaveLength(1)
    expect(files).toHaveLength(2) // 保留末 2 段：多轮轮转后旧段被 .1 覆盖，不无限累积
    // pi- 前缀不变量（架构 D6③）：旋段以 pi- 开头 = cleanExpiredLogs 白名单
    // （startsWith('pi-')）可命中，旋段不会成为无清理写入面
    for (const f of rolled) {
      expect(f.startsWith('pi-')).toBe(true)
      expect(f).toMatch(/^pi-.*\.jsonl\.1$/)
    }
    // 跨段行级连续：.1（旧段）+ 主档（新段）拼接无缺行、单调递增、止于最后写入行
    const indices = [...rolled, ...main].flatMap((f) => extractIndices(readFileSync(join(logsDirPath, f), 'utf8')))
    expect(indices.length).toBeGreaterThanOrEqual(10) // 至少覆盖一个完整轮转周期的尾部
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1] + 1)
    }
    expect(indices[indices.length - 1]).toBe(39)
  })

  it('尾部 flush 走新流：轮转完成后写入的尾部行经 closeLogger 落在新主档（A5）', async () => {
    logger = await import('../logger.js')
    logger.initLogger(dataDir)
    const sid = 'tail-sid-2'
    const sessionLog = logger.createPiSessionLog(sid, { maxBytes: 200 })
    for (let i = 0; i < 10; i++) {
      sessionLog.write(JSON.stringify({ i, pad: 'x'.repeat(10) }))
      await settleWrite()
    }
    // 等 .1 旋段出现且轮转续体收敛（新流已重开、窗口行已回放）
    await waitFor(`.jsonl.1 segment for ${sid}`, () => filesWithMarker(sid).some((f) => f.endsWith('.jsonl.1')))
    await settleWrite()
    // 轮转之后的尾部行必须写进轮转后的新流（注册表 stream 引用已更新）
    sessionLog.write('{"tail":"after-rotation-final-line"}')
    sessionLog.end()
    await logger.closeLogger()

    const rolled = filesWithMarker(sid).find((f) => f.endsWith('.jsonl.1'))!
    const main = filesWithMarker(sid).find((f) => f.endsWith('.jsonl') && !f.endsWith('.1'))!
    const rolledContent = readFileSync(join(logsDirPath, rolled), 'utf8')
    const mainContent = readFileSync(join(logsDirPath, main), 'utf8')
    expect(rolledContent).toContain('"i":0') // 早期行在旧段
    expect(rolledContent).not.toContain('after-rotation-final-line')
    expect(mainContent).toContain('after-rotation-final-line') // 尾部行在新段（flush 走新流）
    expect(extractIndices(mainContent).at(-1)).toBe(9) // 轮转窗口回放 + 后续行无丢失
  })

  it('relay 形态同款：createPiRelayLog 旋段 pi-relay-*.jsonl.1，pi- 前缀白名单覆盖保持', async () => {
    logger = await import('../logger.js')
    logger.initLogger(dataDir)
    const recordId = 'relay-rec-3'
    const relayLog = logger.createPiRelayLog(recordId, { maxBytes: 150 })
    // string 行级写入 + Uint8Array 原始字节镜像（relay up 方向 chunk 形态）混合写入
    for (let i = 0; i < 20; i++) {
      relayLog.write(JSON.stringify({ i, pad: 'y'.repeat(8) }))
      await settleWrite()
    }
    relayLog.write(new TextEncoder().encode('{"raw":"bytes-chunk"}\n'))
    relayLog.end()
    await logger.closeLogger()

    const files = filesWithMarker(recordId)
    const rolled = files.filter((f) => f.endsWith('.jsonl.1'))
    const main = files.filter((f) => f.endsWith('.jsonl') && !f.endsWith('.1'))
    expect(rolled.length).toBeGreaterThanOrEqual(1)
    expect(main).toHaveLength(1)
    // pi-relay- 前缀保持（旋段仍以 pi- 开头 = 保留期清理白名单可命中）
    for (const f of files) expect(f.startsWith('pi-relay-')).toBe(true)
    for (const f of rolled) expect(f.startsWith('pi-')).toBe(true)
    const all = [...rolled, ...main].map((f) => readFileSync(join(logsDirPath, f), 'utf8')).join('')
    expect(all).toContain('"raw":"bytes-chunk"') // Uint8Array chunk 亦随轮转落盘不丢
  })

  it('打开时预滚：磁盘既有文件已超阈值（跨重启场景）先滚动再续写', async () => {
    logger = await import('../logger.js')
    logger.initLogger(dataDir)
    const sid = 'preroll-sid-4'
    // 预置超阈值的历史大文件（上次运行崩溃未轮转——进程内字节计数不覆盖历史字节）。
    // 日期与 logger 同源动态取（toISOString UTC），写死日期会在跨日运行时静默失配
    const today = new Date().toISOString().slice(0, 10)
    const big = join(logsDirPath, `pi-${today}-${sid}.jsonl`)
    mkdirSync(logsDirPath, { recursive: true })
    writeFileSync(big, 'z'.repeat(500))

    const sessionLog = logger.createPiSessionLog(sid, { maxBytes: 200 })
    sessionLog.write('{"after":"restart-line"}')
    sessionLog.end()
    await logger.closeLogger()

    const files = filesWithMarker(sid)
    const rolled = files.find((f) => f.endsWith('.jsonl.1'))
    const main = files.find((f) => f.endsWith('.jsonl') && !f.endsWith('.1'))
    expect(rolled).toBeDefined() // 历史大文件被预滚为 .1
    expect(readFileSync(join(logsDirPath, rolled!), 'utf8')).toBe('z'.repeat(500))
    expect(main).toBeDefined()
    const mainContent = readFileSync(join(logsDirPath, main!), 'utf8')
    expect(mainContent).toContain('{"after":"restart-line"}') // 新行进新主档
    expect(mainContent).not.toContain('zzz') // 历史内容不残留主档
  })
})
