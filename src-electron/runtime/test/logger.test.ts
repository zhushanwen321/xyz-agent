/**
 * logger 模块测试（架构约定 #4）。
 *
 * 覆盖：
 * - initLogger 后 console.* 落盘到 runtime-YYYY-MM-DD.log
 * - 级别过滤（XYZ_LOG_LEVEL 控制）
 * - pi session log（createPiSessionLog 写入 + end）
 * - 未 init 时 no-op（不抛错、不产生副作用）
 * - size 轮转触发 .1 滚动
 *
 * 运行：cd src-electron/runtime && npx vitest run test/logger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'

describe('logger', () => {
  let tmpDir: string
  let logsDir: string
  let originalConsole: { log: typeof console.log; warn: typeof console.warn; error: typeof console.error; info: typeof console.info; debug: typeof console.debug }
  let originalXyzLogLevel: string | undefined

  beforeEach(async () => {
    // 动态 import logger（每次 fresh），但 logger 是模块级单例，需 reset。
    // 用 vi.resetModules 让每个测试拿到干净的模块状态。
    vi.resetModules()
    tmpDir = mkdtempSync(join(tmpdir(), 'logger-test-'))
    logsDir = join(tmpDir, 'logs')
    // 备份原始 console（logger 会 monkey-patch）
    originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    }
    originalXyzLogLevel = process.env.XYZ_LOG_LEVEL
    // 屏蔽测试中 console 的终端输出（logger patch 后 console 仍调 originalConsole.log）
    console.log = () => {}
    console.warn = () => {}
    console.error = () => {}
    console.info = () => {}
    console.debug = () => {}
  })

  afterEach(() => {
    // 恢复 console
    console.log = originalConsole.log
    console.warn = originalConsole.warn
    console.error = originalConsole.error
    console.info = originalConsole.info
    console.debug = originalConsole.debug
    if (originalXyzLogLevel === undefined) delete process.env.XYZ_LOG_LEVEL
    else process.env.XYZ_LOG_LEVEL = originalXyzLogLevel
    delete process.env.XYZ_LOG_MAX_BYTES
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('initLogger 后 console.log 落盘到 runtime-YYYY-MM-DD.log', async () => {
    const { initLogger } = await import('../src/infra/logger.js')
    initLogger(tmpDir)
    // 恢复一个能被 logger patch 调用的 originalConsole（已屏蔽）
    console.log('test-message-12345')
    // 等待 writeStream flush
    await new Promise((r) => setTimeout(r, 50))
    const today = new Date().toISOString().slice(0, 10)
    const files = readdirSync(logsDir)
    expect(files.some((f) => f.startsWith(`runtime-${today}`))).toBe(true)
    const logFile = files.find((f) => f.startsWith(`runtime-${today}`))!
    const content = readFileSync(join(logsDir, logFile), 'utf-8')
    expect(content).toContain('test-message-12345')
  })

  it('级别过滤：XYZ_LOG_LEVEL=warn 时 debug/info 不落盘，warn/error 落盘', async () => {
    process.env.XYZ_LOG_LEVEL = 'warn'
    const { initLogger } = await import('../src/infra/logger.js')
    initLogger(tmpDir)
    console.debug('debug-should-be-filtered')
    console.info('info-should-be-filtered')
    console.warn('warn-should-pass')
    console.error('error-should-pass')
    await new Promise((r) => setTimeout(r, 50))
    const today = new Date().toISOString().slice(0, 10)
    const logFile = readdirSync(logsDir).find((f) => f.startsWith(`runtime-${today}`))!
    const content = readFileSync(join(logsDir, logFile), 'utf-8')
    expect(content).not.toContain('debug-should-be-filtered')
    expect(content).not.toContain('info-should-be-filtered')
    expect(content).toContain('warn-should-pass')
    expect(content).toContain('error-should-pass')
  })

  it('createPiSessionLog 写入 pi stdout JSONL 到独立文件', async () => {
    const { initLogger, createPiSessionLog } = await import('../src/infra/logger.js')
    initLogger(tmpDir)
    const sid = '019f2b5c-54e2-7055-aeb4-464d1b8b74b4'
    const sessionLog = createPiSessionLog(sid)
    sessionLog.write('{"type":"agent_start"}')
    sessionLog.write('{"type":"message_start","message":{"role":"user"}}')
    sessionLog.end()
    await new Promise((r) => setTimeout(r, 50))
    const today = new Date().toISOString().slice(0, 10)
    const piLogFile = readdirSync(logsDir).find((f) => f.startsWith(`pi-${today}-${sid}`))!
    expect(piLogFile).toBeDefined()
    const content = readFileSync(join(logsDir, piLogFile), 'utf-8')
    expect(content).toContain('"type":"agent_start"')
    expect(content).toContain('"type":"message_start"')
    // end() 后流关闭
    expect(sessionLog.write).not.toThrow()
  })

  it('createPiSessionLog 写入自动补换行（pi JSONL 行可能无尾换行）', async () => {
    const { initLogger, createPiSessionLog } = await import('../src/infra/logger.js')
    initLogger(tmpDir)
    const sessionLog = createPiSessionLog('test-sid-nl')
    sessionLog.write('{"a":1}')  // 无换行
    sessionLog.write('{"b":2}\n')  // 有换行
    sessionLog.end()
    await new Promise((r) => setTimeout(r, 50))
    const today = new Date().toISOString().slice(0, 10)
    const piLogFile = readdirSync(logsDir).find((f) => f.startsWith(`pi-${today}-test-sid-nl`))!
    const content = readFileSync(join(logsDir, piLogFile), 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('{"a":1}')
    expect(lines[1]).toBe('{"b":2}')
  })

  it('未 initLogger 时 createPiSessionLog 返回 no-op 写入器（不抛错）', async () => {
    const { createPiSessionLog } = await import('../src/infra/logger.js')
    // 不调 initLogger
    const sessionLog = createPiSessionLog('uninitialized-sid')
    expect(() => {
      sessionLog.write('{"type":"test"}')
      sessionLog.end()
    }).not.toThrow()
  })

  it('size 轮转：文件超 XYZ_LOG_MAX_BYTES 触发 .1 滚动', async () => {
    process.env.XYZ_LOG_MAX_BYTES = '200' // 极小阈值触发轮转
    const { initLogger } = await import('../src/infra/logger.js')
    initLogger(tmpDir)
    // 写入足够多内容触发轮转（每次 console.log 经 patch → writeLogEntry）
    for (let i = 0; i < 30; i++) {
      console.log(`line-${i}-${'x'.repeat(50)}`)
    }
    await new Promise((r) => setTimeout(r, 100))
    const today = new Date().toISOString().slice(0, 10)
    const files = readdirSync(logsDir).filter((f) => f.startsWith(`runtime-${today}`))
    // 应该有主文件 + .1 滚动文件
    expect(files.some((f) => f.endsWith('.log.1'))).toBe(true)
    expect(files.some((f) => f.endsWith('.log') && !f.endsWith('.1'))).toBe(true)
    // 主文件不超过阈值太多（轮转后新开）
    const mainFile = files.find((f) => f.endsWith('.log') && !f.endsWith('.1'))!
    expect(statSync(join(logsDir, mainFile)).size).toBeLessThan(500)
  })

  it('initLogger 幂等：重复调用不重复 patch console', async () => {
    const { initLogger } = await import('../src/infra/logger.js')
    initLogger(tmpDir)
    initLogger(tmpDir) // 重复调用
    console.log('after-double-init')
    await new Promise((r) => setTimeout(r, 50))
    const today = new Date().toISOString().slice(0, 10)
    const logFile = readdirSync(logsDir).find((f) => f.startsWith(`runtime-${today}`))!
    const content = readFileSync(join(logsDir, logFile), 'utf-8')
    // 只出现一次（未重复 patch 不会写两遍）
    const matches = content.match(/after-double-init/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('cleanExpiredLogs 清理 KEEP_DAYS 天前的日志', async () => {
    // 预置一个 10 天前的旧日志文件
    mkdirSync(logsDir, { recursive: true })
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const oldFile = join(logsDir, `runtime-${oldDate}.log`)
    writeFileSync(oldFile, 'old-content')
    // 修改 mtime 为 10 天前
    const oldTime = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000
    statSync(oldFile) // ensure exists
    // 用 utimesSync 改 mtime
    const { utimesSync } = await import('node:fs')
    utimesSync(oldFile, oldTime, oldTime)

    process.env.XYZ_LOG_KEEP_DAYS = '7'
    const { initLogger } = await import('../src/infra/logger.js')
    initLogger(tmpDir) // 触发 cleanExpiredLogs

    const files = readdirSync(logsDir)
    expect(files.some((f) => f === `runtime-${oldDate}.log`)).toBe(false) // 旧文件被清理
  })
})
