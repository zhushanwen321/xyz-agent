/**
 * Worker crash 重建测试 (vitest)
 *
 * 测试 PluginHost 在 Worker crash 后的自动重建逻辑（trusted 语义）：
 * - trusted Worker crash 后自动重建
 * - sandbox 子进程 crash 不重建（不计数；rebuild 仅 trusted 语义）
 * - crashCounts per-plugin 递增
 * - 超过 3 次后放弃
 *
 * trusted Worker 线程加载 fixtures/mock-bootstrap.cjs（经 workerBootstrapOverride 注入，不再写 src 目录）；
 * sandbox fork 子进程加载 fixtures/plugin-bootstrap-process.mock.cjs（经 bootstrapPathOverride 注入）。
 *
 * 运行命令: npx vitest run test/plugin-worker-rebuild.test.ts
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

/**
 * 触发 trusted Worker 崩溃：经 Worker 实例 postMessage({type:'crash'}) → mock exit(1)。
 * 仅适用于 trusted（有 Worker 实例）；sandbox 走 fork 子进程，无 Worker 实例。
 */
async function crashTrustedWorker(host: PluginHost, workerId: string): Promise<void> {
  const instance = host.getWorkerInstance(workerId)
  expect(instance).toBeDefined()
  instance!.postMessage({ type: 'crash' })
  // Wait for crash to propagate
  await new Promise(resolve => setTimeout(resolve, 100))
}

describe('Worker Crash Rebuild', () => {
  it('should rebuild trusted worker after crash', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    host.setRebuildCooldownMs(50)

    const workerId = await host.assignWorker('trusted-plugin', 'trusted')
    expect(workerId.startsWith('trusted-')).toBe(true)
    expect(host.getAllWorkers()).toHaveLength(1)

    await crashTrustedWorker(host, workerId)
    await new Promise(resolve => setTimeout(resolve, 50))

    // Old worker should be cleaned up
    expect(host.getWorkerInstance(workerId)).toBeUndefined()

    // Wait for rebuild cooldown
    await new Promise(resolve => setTimeout(resolve, 100))

    const allWorkers = host.getAllWorkers()
    const trustedActive = allWorkers.filter(w => w.trustLevel === 'trusted' && w.status === 'active')
    expect(trustedActive).toHaveLength(1)
    expect(trustedActive[0].pluginIds).toContain('trusted-plugin')
    expect(host.getCrashCount('trusted-plugin')).toBe(1)

    await host.shutdown()
  })

  it('should NOT rebuild sandbox worker after crash', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { bootstrapPathOverride: PROCESS_MOCK_SOURCE })
    host.setRebuildCooldownMs(50)

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('sandbox-plugin', 'sandbox')
    expect(workerId.startsWith('sandbox-')).toBe(true)

    // sandbox 走 fork 子进程，无 Worker 实例 → 经 handle.postMessage 触发崩溃
    const handle = host.getWorkerHandle('sandbox-plugin')!
    expect(handle).toBeDefined()
    handle.postMessage({ type: 'crash' })
    await new Promise(resolve => setTimeout(resolve, 150))

    // sandbox 崩溃被检测（onCrash 转发）但不计数（rebuild 仅 trusted 语义）
    expect(crashes.length).toBe(1)
    expect(crashes[0].pluginIds).toContain('sandbox-plugin')

    // Wait beyond rebuild cooldown — no rebuild should happen
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(host.getCrashCount('sandbox-plugin')).toBe(0)

    await host.shutdown()
  })

  it('should give up after max rebuild attempts', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    host.setRebuildCooldownMs(50)

    await host.assignWorker('crashy-plugin', 'trusted')

    // Crash 3 times — each time the rebuilt worker gets a new workerId
    for (let i = 0; i < 3; i++) {
      const allWorkers = host.getAllWorkers()
      const trustedActive = allWorkers.filter(w => w.trustLevel === 'trusted' && w.status === 'active')
      expect(trustedActive.length).toBeGreaterThanOrEqual(1)
      const currentWorkerId = trustedActive[0].workerId

      await crashTrustedWorker(host, currentWorkerId)
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    expect(host.getCrashCount('crashy-plugin')).toBe(3)

    // After 3 crashes, count=3, 3 > 3 = false → rebuild still happens
    const after3 = host.getAllWorkers().filter(w => w.trustLevel === 'trusted' && w.status === 'active')
    expect(after3).toHaveLength(1)

    // Crash the 4th time — count=4, 4 > 3 = true → no more rebuild
    await crashTrustedWorker(host, after3[0].workerId)
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(host.getCrashCount('crashy-plugin')).toBe(4)

    const finalWorkers = host.getAllWorkers().filter(w => w.trustLevel === 'trusted' && w.status === 'active')
    expect(finalWorkers).toHaveLength(0)

    await host.shutdown()
  })

  it('crash counts are per-PluginHost instance (non-persistent)', () => {
    const rpc1 = new PluginRpcServer()
    const host1 = new PluginHost(rpc1, { workerBootstrapOverride: WORKER_MOCK })
    expect(host1.getCrashCount('any-plugin')).toBe(0)

    const rpc2 = new PluginRpcServer()
    const host2 = new PluginHost(rpc2, { workerBootstrapOverride: WORKER_MOCK })
    expect(host2.getCrashCount('any-plugin')).toBe(0)

    host1.shutdown()
    host2.shutdown()
  })

  it('should rebuild trusted worker with multiple plugins', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc, { workerBootstrapOverride: WORKER_MOCK })
    host.setRebuildCooldownMs(50)

    const workerId1 = await host.assignWorker('multi-1', 'trusted')
    const workerId2 = await host.assignWorker('multi-2', 'trusted')
    expect(workerId1).toBe(workerId2)

    await crashTrustedWorker(host, workerId1)
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(host.getCrashCount('multi-1')).toBe(1)
    expect(host.getCrashCount('multi-2')).toBe(1)

    const rebuilt = host.getAllWorkers().filter(w => w.trustLevel === 'trusted' && w.status === 'active')
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].pluginIds).toContain('multi-1')
    expect(rebuilt[0].pluginIds).toContain('multi-2')

    await host.shutdown()
  })
})
