/**
 * PluginHost 单元测试
 *
 * 对齐 fork 架构契约（sandbox → fork 子进程 PluginHostProcess，trusted → Worker 线程）：
 * - trusted Worker 线程加载 fixtures/mock-bootstrap.cjs（经 workerBootstrapOverride 注入，不再写 src 目录）
 * - sandbox fork 子进程加载 fixtures/plugin-bootstrap-process.mock.cjs（经 bootstrapPathOverride 注入）
 *
 * 运行命令: npx vitest run test/plugin-host.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** trusted Worker 线程的 mock bootstrap（经 workerBootstrapOverride 注入） */
const WORKER_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')
/** sandbox fork 子进程的 mock bootstrap（经 bootstrapPathOverride 注入） */
const PROCESS_MOCK_SOURCE = resolve(__dirname, 'fixtures/plugin-bootstrap-process.mock.cjs')
/** 常驻版 trusted Worker mock（事件循环保持存活，复现运行中被 terminate → exit code=1） */
const WORKER_MOCK_ALIVE = resolve(__dirname, 'fixtures/mock-bootstrap-alive.cjs')
/** MF-1：sandbox fork 边界断言 execArgv 含 --import；测试用 noop loader 满足契约 */
const NOOP_ESM_LOADER = resolve(__dirname, 'fixtures/noop-esm-loader.cjs')

// [HISTORICAL] 2026-08-20 PR #185：真实 fork 子进程 / Worker 线程用例显式超时——
// assignWorker/loadPlugin/shutdown 走真实子进程与线程生命周期（含 2s SHUTDOWN_KILL
// 宽限），整包满并行 + 系统余载下超 vitest 默认 5s testTimeout（对齐 equivalence
// 真实 pi 用例显式超时口径）。
describe('PluginHost', { timeout: 30_000 }, () => {
  // ── TC-2-01: sandbox 分配独立 fork 子进程 ─────────────────────
  it('TC-2-01: assignWorker for sandbox creates unique fork process per plugin', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    const workerId1 = await host.assignWorker('plugin-a', 'sandbox')
    const workerId2 = await host.assignWorker('plugin-b', 'sandbox')

    // sandbox 插件各自独占 fork 子进程
    expect(workerId1).not.toBe(workerId2)
    expect(workerId1.startsWith('sandbox-')).toBeTruthy()
    expect(workerId2.startsWith('sandbox-')).toBeTruthy()

    // sandbox 走 fork 子进程，不创建 Worker 线程 → getWorkerInstance 为 undefined
    expect(host.getWorkerInstance(workerId1)).toBeUndefined()
    expect(host.getWorkerInstance(workerId2)).toBeUndefined()

    // 通过 pluginId 可拿到 handle（activator 消费 handle.workerId）
    const handle1 = host.getWorkerHandle('plugin-a')
    const handle2 = host.getWorkerHandle('plugin-b')
    expect(handle1).toBeDefined()
    expect(handle2).toBeDefined()
    expect(handle1!.workerId).toBe(workerId1)
    expect(handle2!.workerId).toBe(workerId2)

    await host.shutdown()
  })

  // ── TC-2-02: trusted 共享 Worker 线程 ─────────────────────────
  it('TC-2-02: assignWorker for trusted shares worker (≤10 plugins)', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    const workerId1 = await host.assignWorker('tp-1', 'trusted')
    const workerId2 = await host.assignWorker('tp-2', 'trusted')
    const workerId3 = await host.assignWorker('tp-3', 'trusted')

    // trusted 插件应共享同一个 Worker（≤10 个插件时）
    expect(workerId1).toBe(workerId2)
    expect(workerId2).toBe(workerId3)

    const handle = host.getWorkerHandleById(workerId1)!
    expect(handle).toBeTruthy()
    expect(handle.trustLevel).toBe('trusted')
    expect(handle.pluginIds.length).toBe(3)

    await host.shutdown()
  })

  // ── TC-2-03: terminateWorker 清理 sandbox 子进程 ──────────────
  it('TC-2-03: terminateWorker removes worker', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    const workerId = await host.assignWorker('term-test', 'sandbox')

    expect(host.getWorkerHandle('term-test')).toBeDefined()

    await host.terminateWorker(workerId)

    const afterTerminate = host.getWorkerHandle('term-test')
    expect(afterTerminate).toBe(undefined)

    await host.shutdown()
  })

  // ── 补充：getAllWorkers 初始为空 ─────────────────────────────
  it('getAllWorkers returns empty initially', () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    expect(host.getAllWorkers()).toEqual([])

    host.shutdown()
  })

  // ── 补充：terminateWorker 对不存在的 worker 是 no-op ─────────
  it('terminateWorker is no-op for non-existent worker', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    // 不应抛异常
    await host.terminateWorker('nonexistent-worker')

    await host.shutdown()
  })

  // ── 补充：shutdown 清理所有 sandbox 子进程 ────────────────────
  it('shutdown terminates all workers', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    await host.assignWorker('s-1', 'sandbox')
    await host.assignWorker('s-2', 'sandbox')
    expect(host.getWorkerHandle('s-1')).toBeDefined()
    expect(host.getWorkerHandle('s-2')).toBeDefined()

    await host.shutdown()
    expect(host.getWorkerHandle('s-1')).toBeUndefined()
    expect(host.getWorkerHandle('s-2')).toBeUndefined()
  })

  // ── 补充：sandbox 子进程崩溃转发 crash callback ────────────────
  it('crash callback is invoked when worker errors', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('crash-test', 'sandbox')
    const handle = host.getWorkerHandle('crash-test')!
    expect(handle).toBeDefined()

    // mock bootstrap 收到 crash → process.exit(1) → 子进程 exit(1) → onCrash 转发
    handle.postMessage({ type: 'crash' })

    // 等待子进程退出事件传播
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(crashes.length).toBe(1)
    expect(crashes[0].workerId).toBe(workerId)
    expect(crashes[0].pluginIds).toContain('crash-test')

    await host.shutdown()
  })

  // ── 回归：预期终止不误报崩溃（退出 toast「插件 statusline 崩溃」事故）──
  // 运行中的 Worker 被 terminate() 时 exit code=1（Node 语义），若不先置
  // handle.status='terminated'，exit handler 会误判崩溃 → 假 toast + 无意义 rebuild
  it('terminateWorker does not report crash for expected termination (exit code 1)', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK_ALIVE })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('term-trusted', 'trusted')
    // 先 loadPlugin 等 loaded 回执：保证脚本已求值、常驻句柄已挂，
    // 此时 terminate 才是「运行中被终止 → exit code=1」（否则脚本未求值，自然退出 code=0）
    await host.loadPlugin(workerId, 'term-trusted', '/virtual/plugin', 'trusted')
    const handle = host.getWorkerHandleById(workerId)!

    // 自挂 exit 监听证明场景确为 exit code=1（运行中被 terminate），
    // 排除「Worker 已自然退出 code=0 才没误报」的假通过
    const exitCodes: number[] = []
    host.getWorkerInstance(workerId)!.on('exit', (code) => exitCodes.push(code))

    await host.terminateWorker(workerId)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(exitCodes).toEqual([1])
    expect(handle.status).toBe('terminated')
    expect(crashes).toEqual([])
    expect(host.getCrashCount('term-trusted')).toBe(0)

    await host.shutdown()
  })

  it('shutdown does not report crash for expected termination of live workers', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK_ALIVE })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('shutdown-trusted', 'trusted')
    await host.loadPlugin(workerId, 'shutdown-trusted', '/virtual/plugin', 'trusted')
    const handle = host.getWorkerHandleById(workerId)!

    const exitCodes: number[] = []
    host.getWorkerInstance(workerId)!.on('exit', (code) => exitCodes.push(code))

    await host.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(exitCodes).toEqual([1])
    expect(handle.status).toBe('terminated')
    expect(crashes).toEqual([])
    expect(host.getCrashCount('shutdown-trusted')).toBe(0)
  })

  // ── 回归：process 版 shutdown 同样不误报（sandbox 子进程正常关停）──
  // PluginHostProcess.shutdown() 曾漏掉 pre-mark，SIGTERM 触发的 exit(code=null)
  // 经 `code !== 0` 判定误入 handleProcessCrash → sandbox 插件退出弹假崩溃 toast
  it('shutdown does not report crash for expected termination of sandbox processes', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE, execArgv: ['--import', NOOP_ESM_LOADER] })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('shutdown-sandbox', 'sandbox')
    // 等 loaded 回执：保证子进程已启动且消息回路通畅，kill 时是「存活中被终止」
    await host.loadPlugin(workerId, 'shutdown-sandbox', '/virtual/plugin', 'sandbox')

    await host.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(crashes).toEqual([])
  })

  // ── U7/D5: loadPlugin 超时 → handleWorkerCrash 回收链（P-10 检查点）──
  // fake timers 同步 advance 手法：loadPlugin 内 postMessage 后、无事件循环让渡时
  // 同步 advanceTimersByTime，超时回调确定性先于 Worker 线程的 loaded 回包被主线程
  // 消费（跨线程消息需经真实事件循环派发，fake timer 同步触发）——无需「不回复的
  // bootstrap」即可确定性复现 load 超时。
  it('loadPlugin timeout triggers crash chain: terminate + rebuild scheduling (D5)', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('load-timeout', 'trusted')

    // P-10 检查点实测：load 超时入口 handle.status === 'active'（createWorker 刚创建，
    // 未涉 crash/terminate）——满足 handleWorkerCrash 幂等守卫前置，无需直接 terminate 兜底
    expect(host.getWorkerHandleById(workerId)!.status).toBe('active')

    const worker = host.getWorkerInstance(workerId)!
    const termSpy = vi.spyOn(worker, 'terminate')

    vi.useFakeTimers()
    try {
      const pending = host.loadPlugin(workerId, 'load-timeout', '/virtual/plugin', 'trusted')

      // 默认 LOAD_PLUGIN_TIMEOUT_MS = 10s 精确边界：9_999ms 未超时
      vi.advanceTimersByTime(9_999)
      expect(host.getCrashCount('load-timeout')).toBe(0)
      expect(host.getPendingRebuildTimer(workerId)).toBeUndefined()

      vi.advanceTimersByTime(1)
      await expect(pending).rejects.toThrow(/loadPlugin timeout for worker/)

      // crash 链完整执行：terminate 被调 + handle/索引清理 + crash 计数 + rebuild 排期
      expect(termSpy).toHaveBeenCalledTimes(1)
      expect(host.getWorkerHandleById(workerId)).toBeUndefined()
      expect(host.getCrashCount('load-timeout')).toBe(1)
      expect(host.getPendingRebuildTimer(workerId)).toBeDefined()
      expect(crashes.length).toBe(1)
      expect(crashes[0].error).toContain('loadPlugin timeout')
      expect(crashes[0].pluginIds).toEqual(['load-timeout'])
    } finally {
      vi.useRealTimers()
    }

    // 幂等守卫：本 terminate 触发的 exit(code=1) 不二次 crash（等事件真实传播）
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(crashes.length).toBe(1)
    expect(host.getCrashCount('load-timeout')).toBe(1)

    await host.shutdown()
  })

  // ── U7/D5: loadTimeoutMs 覆盖参数（对齐 fork 版 PluginPoolOptions 先例）──
  it('loadTimeoutMs option overrides the 10s default (fork parity)', async () => {
    const rpc = new PluginRpcServer()
    // 覆盖 2s：2s-1ms 未超时、2s 整触发——证明取的是覆盖值而非默认 10s
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK, loadTimeoutMs: 2_000 })

    const workerId = await host.assignWorker('load-timeout-opt', 'trusted')

    vi.useFakeTimers()
    try {
      const pending = host.loadPlugin(workerId, 'load-timeout-opt', '/virtual/plugin', 'trusted')

      vi.advanceTimersByTime(1_999)
      expect(host.getCrashCount('load-timeout-opt')).toBe(0)
      expect(host.getPendingRebuildTimer(workerId)).toBeUndefined()

      vi.advanceTimersByTime(1)
      expect(host.getCrashCount('load-timeout-opt')).toBe(1)
      expect(host.getPendingRebuildTimer(workerId)).toBeDefined()
      await expect(pending).rejects.toThrow(/after 2000ms/)
    } finally {
      vi.useRealTimers()
    }

    await host.shutdown()
  })
})
