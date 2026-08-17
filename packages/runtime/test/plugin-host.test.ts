/**
 * PluginHost 单元测试
 *
 * 对齐 fork 架构契约（sandbox → fork 子进程 PluginHostProcess，trusted → Worker 线程）：
 * - trusted Worker 线程加载 fixtures/mock-bootstrap.cjs（经 workerBootstrapOverride 注入，不再写 src 目录）
 * - sandbox fork 子进程加载 fixtures/plugin-bootstrap-process.mock.cjs（经 bootstrapPathOverride 注入）
 *
 * 运行命令: npx vitest run test/plugin-host.test.ts
 */

import { describe, it, expect } from 'vitest'
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

describe('PluginHost', () => {
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
})
