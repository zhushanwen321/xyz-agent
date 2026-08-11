/**
 * PluginHost sandbox 分流接线测试（wave: host-process-wiring）。
 *
 * 覆盖：assignWorker/loadPlugin/terminateWorker/getWorkerHandle/shutdown 的
 * sandbox 转调（子进程宿主）+ crash 回调转发 + trusted 回归。
 * - sandbox fork 子进程宿主经 PluginHostProcessOptions.bootstrapPathOverride 注入（fixtures/plugin-bootstrap-process.mock.cjs）
 * - trusted Worker 线程经 workerBootstrapOverride 注入（fixtures/mock-bootstrap.cjs）——
 *   移位后 resolvePluginHostDir() 仍返回 src/services/plugin-service/，删 A1 后 resolve 链
 *   fallback .ts，Node Worker 不能加载 .ts，故 trusted 必须经 override 注入 mock（TC7）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as childProcess from 'node:child_process'
import { PluginHost } from '../src/services/plugin-service/plugin-host.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// spy 保留真实 fork 行为（TC3/TC6 需要真实子进程），仅记录调用次数（TC2 复用断言）
vi.mock('node:child_process', { spy: true })

const MOCK_BOOTSTRAP = resolve(__dirname, 'fixtures/plugin-bootstrap-process.mock.cjs')
const WORKER_MOCK = resolve(__dirname, 'fixtures/mock-bootstrap.cjs')
const FAKE_PLUGIN_PATH = '/fake/plugin.js'

describe('PluginHost sandbox wiring', () => {
  let host: PluginHost
  let rpcServer: PluginRpcServer

  beforeEach(() => {
    vi.mocked(childProcess.fork).mockClear()
    rpcServer = new PluginRpcServer()
    host = new PluginHost(rpcServer, { bootstrapPathOverride: MOCK_BOOTSTRAP, workerBootstrapOverride: WORKER_MOCK })
  })

  afterEach(async () => {
    await host.shutdown()
  })

  it('TC1: sandbox assignWorker 不创建 Worker 线程', async () => {
    const workerId = await host.assignWorker('p1', 'sandbox')
    expect(workerId).toBe('sandbox-p1')
    expect(host.getWorkerInstance('sandbox-p1')).toBeUndefined()
    // fork 子进程已真实创建
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(1)
  })

  it('TC2: sandbox assignWorker 同插件复用子进程', async () => {
    await host.assignWorker('p1', 'sandbox')
    const again = await host.assignWorker('p1', 'sandbox')
    expect(again).toBe('sandbox-p1')
    // 复用：第二次 assign 不新建 fork（assignProcess 内部复用 active 进程）
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(1)
  })

  it('TC3: sandbox loadPlugin 经 mock 宿主成功加载', async () => {
    await host.assignWorker('p1', 'sandbox')
    await expect(
      host.loadPlugin('sandbox-p1', FAKE_PLUGIN_PATH, 'sandbox'),
    ).resolves.toBeUndefined()
  })

  it('TC4: sandbox getWorkerHandle 契约字段映射', async () => {
    await host.assignWorker('p1', 'sandbox')
    const handle = host.getWorkerHandle('p1')
    expect(handle).toBeDefined()
    expect(handle?.workerId).toBe('sandbox-p1') // processId → workerId 映射（activator 消费 handle.workerId）
    expect(typeof handle?.postMessage).toBe('function')
  })

  it('TC5: sandbox terminateWorker 清理子进程', async () => {
    await host.assignWorker('p1', 'sandbox')
    await host.loadPlugin('sandbox-p1', FAKE_PLUGIN_PATH, 'sandbox')
    await host.terminateWorker('sandbox-p1')
    expect(host.getWorkerHandle('p1')).toBeUndefined()
    // 已清理：再次 load 报 Process not found
    await expect(
      host.loadPlugin('sandbox-p1', FAKE_PLUGIN_PATH, 'sandbox'),
    ).rejects.toThrow(/Process not found/)
  })

  it('TC6: sandbox 子进程崩溃转发 onCrash（不 rebuild）', async () => {
    const crashCb = vi.fn()
    host.setCrashCallback(crashCb)
    await host.assignWorker('p1', 'sandbox')
    const handle = host.getWorkerHandle('p1')
    expect(handle).toBeDefined()
    // mock 宿主收到 crash 消息后 process.exit(1) → exit 事件 → handleProcessCrash → onCrash
    handle!.postMessage({ type: 'crash' })
    await vi.waitFor(() => expect(crashCb).toHaveBeenCalledTimes(1), { timeout: 5000 })
    const [processId, pluginIds, error] = crashCb.mock.calls[0]
    expect(processId).toBe('sandbox-p1')
    expect(pluginIds).toContain('p1')
    expect(error).toBeTruthy()
    // crashed 进程不被复用：重新 assign 会创建新 fork（隔离语义），旧 crashed entry 被覆盖
    await host.assignWorker('p1', 'sandbox')
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(2)
  })

  it('TC7: trusted 路径不回归（仍走 Worker 线程）', async () => {
    const workerId = await host.assignWorker('p2', 'trusted')
    expect(workerId).toBe('trusted-1')
    const instance = host.getWorkerInstance('trusted-1')
    expect(instance).toBeDefined()
    // trusted 走 Worker 线程，不创建 fork 子进程
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(0)
  })

  it('TC8: sandbox fork env 注入 XYZ_PLUGIN_SANDBOX_DIR（loader initialize() 依赖）', async () => {
    await host.assignWorker('p1', 'sandbox', '/fake/plugin-dir')
    expect(vi.mocked(childProcess.fork)).toHaveBeenCalledTimes(1)
    const forkCall = vi.mocked(childProcess.fork).mock.calls[0]
    const opts = forkCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined
    // ESM loader initialize() 读此 env 做 sandbox 边界判定，缺失则 fail-closed throw
    expect(opts?.env?.XYZ_PLUGIN_SANDBOX_DIR).toBe('/fake/plugin-dir')
    // 打包约束（AGENTS.md #12）仍生效
    expect(opts?.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('TC9: sandbox 未传 pluginDir 时 fork env 不含 XYZ_PLUGIN_SANDBOX_DIR（loader fail-closed 兑现）', async () => {
    await host.assignWorker('p1', 'sandbox')
    const forkCall = vi.mocked(childProcess.fork).mock.calls[0]
    const opts = forkCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined
    // env 缺失时 ESM loader initialize() throw（子进程启动即崩溃）——fail-closed 安全语义
    expect(opts?.env?.XYZ_PLUGIN_SANDBOX_DIR).toBeUndefined()
  })
})
