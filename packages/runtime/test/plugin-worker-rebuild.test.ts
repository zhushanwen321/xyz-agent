/**
 * Worker crash 重建测试 (vitest)
 *
 * 测试 PluginHost 在 Worker crash 后的自动重建逻辑（trusted 语义）：
 * - trusted Worker crash 后自动重建
 * - sandbox 子进程 crash 不重建（不计数；rebuild 仅 trusted 语义）
 * - crashCounts per-plugin 递增
 * - 超过 3 次后放弃
 *
 * 运行命令: pnpm --filter @xyz-agent/runtime run test -- test/plugin-worker-rebuild.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// trusted Worker 线程的 mock bootstrap（运行时写入 plugin-bootstrap.js）
const WORKER_MOCK_SOURCE = resolve(
  __dirname,
  '../src/services/plugin-service/plugin-bootstrap.mock.cjs',
)
// sandbox fork 子进程的 mock bootstrap（经 bootstrapPathOverride 注入）
const PROCESS_MOCK_SOURCE = resolve(
  __dirname,
  '../src/services/plugin-service/plugin-bootstrap-process.mock.cjs',
)
// Worker 从 resolvePluginHostDir() 加载 bootstrap，即 plugin-host.ts 的目录
const TARGET_BOOTSTRAP = resolve(
  __dirname,
  '../src/services/plugin-service/plugin-bootstrap.js',
)

let originalContent: string | null = null
let targetExisted = false

beforeAll(() => {
  // 记录原始文件是否存在，存在则备份内容
  if (existsSync(TARGET_BOOTSTRAP)) {
    targetExisted = true
    originalContent = readFileSync(TARGET_BOOTSTRAP, 'utf-8')
  }
})

// beforeEach（而非 beforeAll）重写 mock：与 plugin-host.test.ts 并行运行时，两者共享
// 此文件，另一文件的 afterAll 恢复可能在本文件测试间隙清空它；每个用例前重新写入，
// 保证本测试创建的 trusted Worker 总能加载到 mock（修复并行运行时的跨文件干扰）。
beforeEach(() => {
  const mockCode = readFileSync(WORKER_MOCK_SOURCE, 'utf-8')
  writeFileSync(TARGET_BOOTSTRAP, mockCode, 'utf-8')
})

afterAll(() => {
  if (targetExisted && originalContent !== null) {
    // 恢复原始内容
    writeFileSync(TARGET_BOOTSTRAP, originalContent, 'utf-8')
  } else if (!targetExisted) {
    // 文件原本不存在，清理
    try { unlinkSync(TARGET_BOOTSTRAP) } catch { /* best effort */ }
  }
})

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
    const host = new PluginHost(rpc)
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
    const host = new PluginHost(rpc)
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
    const host1 = new PluginHost(rpc1)
    expect(host1.getCrashCount('any-plugin')).toBe(0)

    const rpc2 = new PluginRpcServer()
    const host2 = new PluginHost(rpc2)
    expect(host2.getCrashCount('any-plugin')).toBe(0)

    host1.shutdown()
    host2.shutdown()
  })

  it('should rebuild trusted worker with multiple plugins', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc)
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
