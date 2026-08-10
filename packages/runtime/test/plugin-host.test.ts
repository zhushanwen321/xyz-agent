/**
 * PluginHost 单元测试
 *
 * 对齐 fork 架构契约（commit 9d62245a2：sandbox → fork 子进程 PluginHostProcess，
 * trusted → Worker 线程）：
 * - trusted Worker 线程加载 test/fixtures/mock-bootstrap.cjs（运行时写入 plugin-bootstrap.js）
 * - sandbox fork 子进程加载 plugin-bootstrap-process.mock.cjs（经 bootstrapPathOverride 注入）
 *
 * 运行命令: pnpm --filter @xyz-agent/runtime run test -- test/plugin-host.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** trusted Worker 线程的 mock bootstrap（运行时写入 plugin-bootstrap.js） */
const WORKER_MOCK_SOURCE = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')
/** sandbox fork 子进程的 mock bootstrap（经 bootstrapPathOverride 注入） */
const PROCESS_MOCK_SOURCE = resolve(
  __dirname,
  '../src/services/plugin-service/plugin-bootstrap-process.mock.cjs',
)
/**
 * PluginHost（trusted 路径）通过 resolvePluginHostDir() 解析 bootstrap：
 *   resolve(dirname(fileURLToPath(import.meta.url)), 'plugin-bootstrap.js')
 * tsx 运行时 import.meta.url 指向 .ts 源文件，所以目标路径是
 *   runtime/src/services/plugin-service/plugin-bootstrap.js
 */
const TARGET_BOOTSTRAP = resolve(
  __dirname,
  '../src/services/plugin-service/plugin-bootstrap.js',
)

let originalContent: string | null = null
let targetExisted = false

beforeAll(() => {
  if (existsSync(TARGET_BOOTSTRAP)) {
    targetExisted = true
    originalContent = readFileSync(TARGET_BOOTSTRAP, 'utf-8')
  }
})

// beforeEach（而非 beforeAll）重写 mock：与 plugin-worker-rebuild.test.ts 并行运行时，
// 两者共享此文件，另一文件的 afterAll 恢复可能在本文件测试间隙清空它；每个用例前重新
// 写入，保证本测试创建的 Worker 总能加载到 mock（修复并行运行时的跨文件干扰）。
beforeEach(() => {
  const mockCode = readFileSync(WORKER_MOCK_SOURCE, 'utf-8')
  writeFileSync(TARGET_BOOTSTRAP, mockCode, 'utf-8')
})

afterAll(() => {
  if (targetExisted && originalContent !== null) {
    writeFileSync(TARGET_BOOTSTRAP, originalContent, 'utf-8')
  } else if (!targetExisted) {
    try { unlinkSync(TARGET_BOOTSTRAP) } catch { /* best effort */ }
  }
})

describe('PluginHost', () => {
  // ── TC-2-01: sandbox 分配独立 fork 子进程 ─────────────────────
  it('TC-2-01: assignWorker for sandbox creates unique fork process per plugin', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE })

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
    const host = new PluginHost(rpc)

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
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE })

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
    const host = new PluginHost(rpc)

    expect(host.getAllWorkers()).toEqual([])

    host.shutdown()
  })

  // ── 补充：terminateWorker 对不存在的 worker 是 no-op ─────────
  it('terminateWorker is no-op for non-existent worker', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc)

    // 不应抛异常
    await host.terminateWorker('nonexistent-worker')

    await host.shutdown()
  })

  // ── 补充：shutdown 清理所有 sandbox 子进程 ────────────────────
  it('shutdown terminates all workers', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE })

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
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE })

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
})
