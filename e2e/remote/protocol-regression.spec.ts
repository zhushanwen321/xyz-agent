/**
 * 协议回归 E2E —— 把各 verify-*.cjs 纳入 Playwright 编排。
 *
 * 不用浏览器 fixture，而是 spawn 每个 verify 脚本（真起 runtime 子进程），
 * 等退出，断言 exit code === 0。每个 verify 脚本内部自管 runtime 生命周期
 * （spawn server.cjs → 跑协议用例 → kill），exit 0 = 全部 PASS，exit 1 = 任一 FAIL。
 *
 * 编排意图（spec remote-use G6 协议回归门禁）：
 *  - TC1 verify-remote-auth（P0 认证）：无 auth / 错误 token / 正确 token / file.signUrl / GET /file
 *  - TC2 verify-replay（P2 回放）：seq 打点 + per-session ring buffer + 重连回放
 *  - TC3 verify-lease（P5 租约）：lease 互斥 + busyOwner 拒绝 + TTL 释放 + abort 释放
 *  - TC4 verify-mobile-web（P4 全链路）：WS 协议层全链路（dist 缺失则 exit 0 + SKIPPED）
 *  - TC5 verify-concurrency（P6 并发）：并发消息 + pi/model 可用性降级
 *
 * 串行：remote 项目继承 playwright.config.ts 全局 workers:1。各 verify 脚本虽用不同端口
 * （13591/13601/13599/...），但都真起 runtime + pi 子进程，并发易争资源，串行最稳。
 *
 * 超时：verify-lease 等 TTL 过期（3s TTL + 5s reaper），verify-concurrency 真跑 pi，
 * 单脚本可能 30-120s。Playwright test timeout 设 180s（remote 项目默认 120s 不够）。
 *
 * dist 依赖：global-setup（assertRemoteArtifacts）已校验 runtime/mobile/非 mock renderer 产物存在，
 * 缺失时 globalSetup 抛错终止整个 run。本 spec 假设 dist 已就绪。
 *
 * 失败诊断：每个用例捕获 stdout/stderr 全量，仅在断言失败时打印尾部（避免输出爆炸）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const TOOLS_DIR = resolve(REPO_ROOT, 'tools')

/** 单脚本最长等待（含 TTL 过期 / pi 真跑）。超过则 kill 整个进程树，标 timeout。 */
const SCRIPT_TIMEOUT_MS = 180_000
/** Playwright 单测超时（SCRIPT_TIMEOUT_MS + 余量，确保 kill + 收尾完成）。 */
const TEST_TIMEOUT_MS = 200_000

interface VerifyResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/**
 * Spawn 一个 verify 脚本，等退出，收集 stdout/stderr。
 *
 * timeout 时 SIGTERM 主进程 + SIGKILL 兜底，确保无僵尸 runtime/pi 子进程
 * （verify 脚本内部自管 runtime 生命周期，但被外力 kill 时其 runtime 子进程可能成孤儿；
 *  这里 kill 主进程后 SIGKILL 兜底，runtime 子进程若监听父进程退出也会自尽；
 *  若仍残留，由各 verify 脚本自己的 cleanup 兜底，本 spec 不越俎代庖 kill 全树以免误伤）。
 */
async function runVerifyScript(scriptName: string): Promise<VerifyResult> {
  const scriptPath = resolve(TOOLS_DIR, scriptName)
  const startedAt = Date.now()

  return new Promise<VerifyResult>((resolvePromise) => {
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn('node', [scriptPath], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolvePromise({
        exitCode: null,
        stdout: '',
        stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      // SIGTERM 后 3s 仍存活则 SIGKILL 兜底
      setTimeout(() => {
        if (!settled) {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, 3_000).unref?.()
    }, SCRIPT_TIMEOUT_MS)

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')

    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const finish = (result: VerifyResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      resolvePromise(result)
    }

    proc.on('error', (err) => {
      finish({
        exitCode: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })

    proc.on('close', (code) => {
      finish({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}

/** 截取尾部 N 字符，避免失败日志爆炸（verify 脚本实时输出进度可能很长）。 */
function tail(text: string, maxBytes = 8_000): string {
  if (text.length <= maxBytes) return text
  return `...[truncated ${text.length - maxBytes} chars]...\n` + text.slice(-maxBytes)
}

/** 构造失败诊断信息：耗时 + exit code + stdout/stderr 尾部。 */
function diagnose(scriptName: string, result: VerifyResult): string {
  const lines = [
    `${scriptName} 失败（耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
    `exitCode=${result.exitCode}${result.timedOut ? ' (TIMEOUT)' : ''}`,
    '--- stdout (tail) ---',
    tail(result.stdout),
    '--- stderr (tail) ---',
    tail(result.stderr),
  ]
  return lines.join('\n')
}

// 串行：remote 项目 workers=1 已串行；test.describe.serial 显式标注意图 + 防并行 mode 串扰。
// verify 脚本都真起 runtime + pi 子进程，并发易争资源/端口。
test.describe.serial('协议回归（verify 脚本门禁）', () => {
  test.describe.configure({ timeout: TEST_TIMEOUT_MS })

  test('TC1: verify-remote-auth — P0 认证握手 + file.signUrl', async () => {
    const result = await runVerifyScript('verify-remote-auth.cjs')

    // exit 0 = 全部 PASS
    expect.soft(result.timedOut, '脚本超时').toBe(false)
    expect(
      result.exitCode,
      diagnose('verify-remote-auth.cjs', result),
    ).toBe(0)

    // 协议门禁诚实性：exit 0 时不应出现 FAIL 标记
    expect(
      result.stdout,
      'exit 0 但 stdout 含 FAIL：' + tail(result.stdout),
    ).not.toContain('FAIL')
  })

  test('TC2: verify-replay — P2 可靠投递回放', async () => {
    const result = await runVerifyScript('verify-replay.cjs')

    expect.soft(result.timedOut, '脚本超时').toBe(false)
    expect(
      result.exitCode,
      diagnose('verify-replay.cjs', result),
    ).toBe(0)

    expect(
      result.stdout,
      'exit 0 但 stdout 含 FAIL：' + tail(result.stdout),
    ).not.toContain('FAIL')
  })

  test('TC3: verify-lease — P5 租约互斥 + TTL/abort 释放', async () => {
    // verify-lease 用 XYZ_AGENT_LEASE_TTL_MS=3000 缩短 TTL，等 3s TTL + 5s reaper 扫描，
    // 单脚本耗时较长（两个场景各含一次 TTL 过期等待）。
    const result = await runVerifyScript('verify-lease.cjs')

    expect.soft(result.timedOut, '脚本超时（TTL/reaper 等待过长）').toBe(false)
    expect(
      result.exitCode,
      diagnose('verify-lease.cjs', result),
    ).toBe(0)

    expect(
      result.stdout,
      'exit 0 但 stdout 含 FAIL：' + tail(result.stdout),
    ).not.toContain('FAIL')
  })

  test('TC4: verify-mobile-web — P4 全链路（WS 协议层）', async () => {
    // verify-mobile-web 在 runtime/mobile dist 缺失时友好降级：exit 0 + stdout 标 SKIPPED。
    // global-setup 已校验 dist 存在（缺失则整个 run 终止），故正常应真跑 PASS；
    // 但仍兼容 SKIPPED（exit 0 即门禁通过，SKIPPED 仅作日志标注）。
    const result = await runVerifyScript('verify-mobile-web.cjs')

    expect.soft(result.timedOut, '脚本超时').toBe(false)
    expect(
      result.exitCode,
      diagnose('verify-mobile-web.cjs', result),
    ).toBe(0)

    const skipped = result.stdout.includes('SKIPPED')
    if (skipped) {
      // SKIPPED 是 exit 0 的合法降级，但日志标注以便人工可见
      test.info().annotations.push({
        type: 'skipped',
        description: 'verify-mobile-web 降级 SKIPPED（dist 可能缺失）：' + tail(result.stdout, 1000),
      })
    } else {
      // 真跑时不应有 FAIL
      expect(
        result.stdout,
        'exit 0 但 stdout 含 FAIL：' + tail(result.stdout),
      ).not.toContain('FAIL')
    }
  })

  test('TC5: verify-concurrency — P6 并发消息 + 降级', async () => {
    // verify-concurrency 场景 1 真跑；场景 2/3 按 pi/model 可用性真跑或降级（SKIP 非 FAIL）。
    const result = await runVerifyScript('verify-concurrency.cjs')

    expect.soft(result.timedOut, '脚本超时（pi 真跑可能较慢）').toBe(false)
    expect(
      result.exitCode,
      diagnose('verify-concurrency.cjs', result),
    ).toBe(0)

    // verify-concurrency 区分 SKIP（降级）与 FAIL；exit 0 时不应有 FAIL
    expect(
      result.stdout,
      'exit 0 但 stdout 含 FAIL：' + tail(result.stdout),
    ).not.toContain('FAIL')
  })
})
