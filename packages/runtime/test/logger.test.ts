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
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/logger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'

describe('logger', () => {
  let tmpDir: string
  let logsDir: string
  let originalConsole: { log: typeof console.log; warn: typeof console.warn; error: typeof console.error; info: typeof console.info; debug: typeof console.debug }
  /** logger 模块 import 时读取的全部 env 的快照（beforeEach 保存 / afterEach 恢复，隔离测试间与外部进程污染，审查 W30 Fix-6）。 */
  const LOG_ENV_KEYS = ['XYZ_LOG_MAX_BYTES', 'XYZ_LOG_KEEP_DAYS', 'XYZ_LOG_LEVEL'] as const
  let savedEnv: Record<string, string | undefined>

  /**
   * 轮询等待 dir 下前缀匹配 prefix 的文件内容包含 substr（写流 flush/fsync 落盘是
   * 异步的，固定 sleep 满载下不可靠）。substr 省略时只等文件出现。
   * 目录/文件尚未创建均视为未就绪继续轮询；deadline 默认 5s、间隔 25ms，
   * 超时抛错并附当前实际内容便于定位。
   */
  async function waitForLogContent(
    dir: string,
    prefix: string,
    substr?: string,
    deadlineMs = 5000,
  ): Promise<{ name: string; content: string }> {
    const deadline = Date.now() + deadlineMs
    let lastName = ''
    let lastContent = ''
    for (;;) {
      try {
        const name = readdirSync(dir).find((f) => f.startsWith(prefix))
        if (name !== undefined) {
          lastName = name
          lastContent = readFileSync(join(dir, name), 'utf-8')
          if (substr === undefined || lastContent.includes(substr)) return { name, content: lastContent }
        }
      } catch { /* 目录/文件尚未创建，继续轮询 */ }
      if (Date.now() >= deadline) {
        throw new Error(
          `waitForLogContent timeout (${deadlineMs}ms): ${substr ?? `file ${prefix}*`} not found in ${dir}; `
          + `last file: ${lastName}, actual content: ${JSON.stringify(lastContent)}`,
        )
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /**
   * 等待**精确文件名**的文件内容包含 substr（写流 flush 是异步的，固定 sleep 满载下不可靠）。
   *
   * 与 waitForLogContent 的区别：prefix startsWith 匹配在「主文件 + .1 滚动」并存时无法
   * 区分两者（`runtime-<date>.log` 前缀同时命中 `.log.1`，且 readdir 顺序稳定时 find 恒
   * 返回同一文件，内容不匹配会死等到超时），size 轮转断言需要锁定主文件本体。
   * 文件尚未创建视为未就绪继续轮询；deadline 默认 5s、间隔 25ms。
   */
  async function waitForNamedFileContent(
    dir: string,
    fileName: string,
    substr: string,
    deadlineMs = 5000,
  ): Promise<string> {
    const deadline = Date.now() + deadlineMs
    let lastContent = ''
    for (;;) {
      try {
        lastContent = readFileSync(join(dir, fileName), 'utf-8')
        if (lastContent.includes(substr)) return lastContent
      } catch { /* 文件尚未创建（如轮转 rename 后 reopen 前），继续轮询 */ }
      if (Date.now() >= deadline) {
        throw new Error(
          `waitForNamedFileContent timeout (${deadlineMs}ms): ${fileName} in ${dir} lacks ${JSON.stringify(substr)}; `
          + `actual content: ${JSON.stringify(lastContent)}`,
        )
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

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
    savedEnv = Object.fromEntries(LOG_ENV_KEYS.map((k) => [k, process.env[k]]))
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
    // 恢复（而非仅删除）原值：外部环境若设了这些变量，测试不得吞掉后不还
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    // maxRetries 对齐 sync-collect-recovery.test.ts 先例：与刚 close 的真实写流
    // 在途 flush/fsync 竞争时重试删除，消除满载下 ENOTEMPTY 偶发
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('initLogger 后 console.log 落盘到 runtime-YYYY-MM-DD.log', async () => {
    const { initLogger } = await import('../src/infra/logger.js')
    initLogger(tmpDir)
    // 恢复一个能被 logger patch 调用的 originalConsole（已屏蔽）
    console.log('test-message-12345')
    // 轮询等写流落盘（固定 sleep 满载下不够）
    const today = new Date().toISOString().slice(0, 10)
    const content = (await waitForLogContent(logsDir, `runtime-${today}`, 'test-message-12345')).content
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
    const today = new Date().toISOString().slice(0, 10)
    // 先轮询等正向内容（error 最后写入，同一写流 FIFO——它落盘则 warn 必已落盘）
    await waitForLogContent(logsDir, `runtime-${today}`, 'error-should-pass')
    const logFile = readdirSync(logsDir).find((f) => f.startsWith(`runtime-${today}`))!
    const content = readFileSync(join(logsDir, logFile), 'utf-8')
    // 负向断言在正向已落盘之后：被过滤的 debug/info 根本没进写流，此刻读全文断言安全
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
    // 轮询等两条 JSON 行落盘（最后一条出现 = 前一条已落盘，同一写流 FIFO）
    const today = new Date().toISOString().slice(0, 10)
    const piLogFile = (await waitForLogContent(logsDir, `pi-${today}-${sid}`, '"type":"message_start"')).name
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
    // 轮询等两行落盘后再断言行数与顺序
    const today = new Date().toISOString().slice(0, 10)
    const piLogFile = (await waitForLogContent(logsDir, `pi-${today}-test-sid-nl`, '{"b":2}')).name
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
    const { initLogger, closeLogger } = await import('../src/infra/logger.js')
    initLogger(tmpDir)
    // 写入足够多内容触发轮转（每次 console.log 经 patch → writeLogEntry）。
    // W30 起轮转为异步（end 旧流等待 flush 完成 → rename → 开新流），写入间让出
    // 事件循环：fd open / 在途 fs.write 在 tick 间完成，轮转在下一轮写入前落盘。
    for (let i = 0; i < 30; i++) {
      console.log(`line-${i}-${'x'.repeat(50)}`)
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    }
    const today = new Date().toISOString().slice(0, 10)
    // 轮转异步完成（end 旧流 flush → rename → 开新流 → 回放）后进稳态再断言。
    // 此前「轮询到 .1 出现 → 立即 readdir」满载并行下 flaky：.1 从首轮轮转起持续存在，
    // 轮询返回时刻可能正有后续轮转处于 rename 与新主文件重建（createWriteStream 异步
    // open）之间的瞬态窗口——目录只有 .1 没有 .log，断言假红；写入结束后仍可能有末轮
    // 轮转在途。closeLogger 是 logger 既有确定性钩子：await 在途轮转（含队列回放）→
    // end 全部写流并等 flush 完成——返回即目录状态冻结（再无写入 → 不再触发轮转），
    // 下方 readdir/statSync 断言无竞态，顺带消除 afterEach rmSync 与在途 flush 的
    // ENOTEMPTY 竞争（对齐 src/__tests__/logger-rotation.test.ts 的 closeLogger 屏障先例）。
    await closeLogger()
    const files = readdirSync(logsDir).filter((f) => f.startsWith(`runtime-${today}`))
    // 应该有主文件 + .1 滚动文件（多轮轮转 ≥1 次 rename 已随上方等待完成）
    expect(files.some((f) => f.endsWith('.log.1'))).toBe(true)
    expect(files.some((f) => f.endsWith('.log') && !f.endsWith('.1'))).toBe(true)
    // 主文件（未滚动段）严格小于总写入量：轮转把早期数据切进了 .1（.1 段 ≥ 阈值，非空）。
    // 不做绝对 size 上限——异步轮转窗口内的回放可让主文件短暂超过阈值，绝对上限在并行
    // 负载下 flaky（审查 W30 Fix-5 同款；正确性由上方 .1 存在断言 + src/__tests__/
    // logger.test.ts 的跨文件行级连续性断言覆盖）。
    const mainFile = files.find((f) => f.endsWith('.log') && !f.endsWith('.1'))!
    const totalBytes = files.reduce((sum, f) => sum + statSync(join(logsDir, f)).size, 0)
    expect(statSync(join(logsDir, mainFile)).size).toBeLessThan(totalBytes)
  })

  it('initLogger 幂等：重复调用不重复 patch console', async () => {
    const { initLogger } = await import('../src/infra/logger.js')
    initLogger(tmpDir)
    initLogger(tmpDir) // 重复调用
    console.log('after-double-init')
    const today = new Date().toISOString().slice(0, 10)
    // 轮询等落盘；此后不再有写入，出现次数断言稳定
    const logFile = (await waitForLogContent(logsDir, `runtime-${today}`, 'after-double-init')).name
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
