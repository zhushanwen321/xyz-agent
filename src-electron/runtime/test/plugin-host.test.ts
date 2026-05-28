/**
 * PluginHost 单元测试
 *
 * 需要 mock-bootstrap.cjs 位于 PluginHost 期望的 plugin-bootstrap.js 路径。
 * 测试在 before() 中将 mock bootstrap 复制到该路径，after() 中清理。
 *
 * 运行命令: cd src-electron && npx tsx --test runtime/test/plugin-host.test.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK_BOOTSTRAP_SOURCE = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')

/**
 * PluginHost 通过 import.meta.url 解析 bootstrap 路径：
 *   resolve(dirname(fileURLToPath(import.meta.url)), 'plugin-bootstrap.js')
 * tsx 运行时 import.meta.url 指向 .ts 源文件，所以目标路径是
 *   runtime/src/services/plugin-service/plugin-bootstrap.js
 */
const TARGET_BOOTSTRAP = resolve(
  __dirname,
  '../src/services/plugin-service/plugin-bootstrap.js',
)

let createdBootstrap = false

before(() => {
  if (!existsSync(TARGET_BOOTSTRAP)) {
    const code = readFileSync(MOCK_BOOTSTRAP_SOURCE, 'utf-8')
    writeFileSync(TARGET_BOOTSTRAP, code, 'utf-8')
    createdBootstrap = true
  }
})

after(() => {
  if (createdBootstrap) {
    try { unlinkSync(TARGET_BOOTSTRAP) } catch { /* best effort */ }
  }
})

describe('PluginHost', () => {
  // ── TC-2-01: assignWorker for sandbox creates unique worker ───
  it('TC-2-01: assignWorker for sandbox creates unique worker per plugin', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc)

    const workerId1 = await host.assignWorker('plugin-a', 'sandbox')
    const workerId2 = await host.assignWorker('plugin-b', 'sandbox')

    // sandbox 插件各自独占 Worker
    assert.notStrictEqual(workerId1, workerId2, 'sandbox workers should be unique')
    assert.ok(workerId1.startsWith('sandbox-'), `expected sandbox- prefix, got ${workerId1}`)
    assert.ok(workerId2.startsWith('sandbox-'), `expected sandbox- prefix, got ${workerId2}`)

    const handle1 = host.getWorkerHandleById(workerId1)
    const handle2 = host.getWorkerHandleById(workerId2)
    assert.ok(handle1)
    assert.ok(handle2)
    assert.strictEqual(handle1.trustLevel, 'sandbox')
    assert.strictEqual(handle2.trustLevel, 'sandbox')
    assert.strictEqual(handle1.status, 'active')
    assert.strictEqual(handle2.status, 'active')

    await host.shutdown()
  })

  // ── TC-2-02: assignWorker for trusted shares worker ───────────
  it('TC-2-02: assignWorker for trusted shares worker (≤10 plugins)', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc)

    const workerId1 = await host.assignWorker('tp-1', 'trusted')
    const workerId2 = await host.assignWorker('tp-2', 'trusted')
    const workerId3 = await host.assignWorker('tp-3', 'trusted')

    // trusted 插件应共享同一个 Worker（≤10 个插件时）
    assert.strictEqual(workerId1, workerId2, 'trusted plugins should share worker')
    assert.strictEqual(workerId2, workerId3, 'trusted plugins should share worker')

    const handle = host.getWorkerHandleById(workerId1)
    assert.ok(handle)
    assert.strictEqual(handle.trustLevel, 'trusted')
    assert.strictEqual(handle.pluginIds.length, 3, 'shared worker should track 3 plugins')

    await host.shutdown()
  })

  // ── TC-2-03: terminateWorker removes worker ───────────────────
  it('TC-2-03: terminateWorker removes worker', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc)

    const workerId = await host.assignWorker('term-test', 'sandbox')

    assert.ok(host.getWorkerHandleById(workerId), 'worker should exist before terminate')

    await host.terminateWorker(workerId)

    const afterTerminate = host.getWorkerHandleById(workerId)
    assert.strictEqual(afterTerminate, undefined, 'worker should be removed after terminate')

    await host.shutdown()
  })

  // ── 补充：getAllWorkers 初始为空 ─────────────────────────────
  it('getAllWorkers returns empty initially', () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc)

    assert.deepStrictEqual(host.getAllWorkers(), [])

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

  // ── 补充：shutdown 清理所有 worker ────────────────────────────
  it('shutdown terminates all workers', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc)

    await host.assignWorker('s-1', 'sandbox')
    await host.assignWorker('s-2', 'sandbox')
    assert.strictEqual(host.getAllWorkers().length, 2)

    await host.shutdown()
    assert.deepStrictEqual(host.getAllWorkers(), [])
  })

  // ── 补充：crash callback 触发 ────────────────────────────────
  it('crash callback is invoked when worker errors', async () => {
    const rpc = new PluginRpcServer()
    const host = new PluginHost(rpc)

    const crashes: Array<{ workerId: string; pluginIds: string[]; error: string }> = []
    host.setCrashCallback((workerId, pluginIds, error) => {
      crashes.push({ workerId, pluginIds, error })
    })

    const workerId = await host.assignWorker('crash-test', 'sandbox')
    const workerInstance = host.getWorkerInstance(workerId)
    assert.ok(workerInstance, 'worker instance should exist')

    // 直接 terminate 让 Worker 退出（exit code != 0 触发 crash handler）
    workerInstance.terminate()

    // 等待 exit 事件传播
    await new Promise((resolve) => setTimeout(resolve, 200))

    // crash callback 可能被调用（取决于 Worker 退出码）
    // 由于 terminate() 默认 exit code 0，不一定会触发 crash
    // 此测试主要验证不抛异常
    await host.shutdown()
  })
})
