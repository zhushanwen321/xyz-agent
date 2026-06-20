/**
 * 插件系统集成测试
 *
 * 测试完整的 scan → activate → deactivate 流程。
 * TC-int-01 使用 mock host（纯逻辑，不依赖真实 Worker）验证组件协作。
 * TC-int-02/03 使用真实文件系统验证 storage 持久化。
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import { PluginStorage } from '../src/services/plugin-service/plugin-storage.js'
import { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(__dirname, 'fixtures/plugins')

let tmpDir: string
let registry: PluginRegistry
let storage: PluginStorage
let rpcServer: PluginRpcServer
let activator: PluginActivator

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-integration-test-'))
  const pluginDir = join(tmpDir, '.xyz-agent', 'plugins', 'hello-world')
  await mkdir(pluginDir, { recursive: true })
  await cp(join(FIXTURES_DIR, 'hello-world'), pluginDir, { recursive: true })

  registry = new PluginRegistry(tmpDir, tmpDir)
  storage = new PluginStorage()
  rpcServer = new PluginRpcServer()
  activator = new PluginActivator()

  storage.init(tmpDir, tmpDir)
})

afterAll(async () => {
  storage.flushAll()
  await rm(tmpDir, { recursive: true, force: true })
})

/**
 * 创建 mock host，模拟 Worker 的 activated/deactivated 回复。
 * 每当 activator 通过 postMessage 发送 activate/deactivate 消息时，
 * 在 microtask 中调用 activator.handleWorkerReply 模拟 Worker 回复。
 */
function createIntegrationHost(activator: PluginActivator): ActivatorHost {
  return {
    assignWorker: vi.fn((_pluginId: string, _trustLevel: 'trusted' | 'sandbox') =>
      Promise.resolve('mock-worker-1'),
    ),
    loadPlugin: vi.fn(() => Promise.resolve()),
    getWorkerHandle: vi.fn((pluginId: string) => ({
      workerId: 'mock-worker-1',
      postMessage: vi.fn((msg: unknown) => {
        const m = msg as { type: string; pluginId?: string }
        if (m.type === 'activate') {
          queueMicrotask(() => {
            activator.handleWorkerReply({ type: 'activated', pluginId })
          })
        } else if (m.type === 'deactivate') {
          queueMicrotask(() => {
            activator.handleWorkerReply({ type: 'deactivated', pluginId })
          })
        }
      }),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}

describe('Plugin Integration', () => {
  // ── TC-int-01: full scan → activate → deactivate flow ────────
  it('TC-int-01: full scan → activate → deactivate flow', async () => {
    const host = createIntegrationHost(activator)

    // 1. 扫描发现插件
    const descriptors = await registry.scan()
    expect(descriptors.length >= 1).toBeTruthy()
    const hw = descriptors.find(d => d.pluginId === 'hello-world')!
    expect(hw).toBeTruthy()
    expect(hw.trustLevel).toBe('trusted')
    expect(hw.activationEvents.includes('onStartupFinished')).toBeTruthy()

    // 2. 注册描述符
    activator.registerDescriptors(descriptors)
    expect(activator.getState('hello-world')).toBe('UNLOADED')

    // 3. 注册 RPC storage 方法（模拟 PluginService.registerRpcMethods）
    rpcServer.registerMethod('plugin.storage.global.get', async (params) => {
      return storage.get(params.pluginId as string, params.key as string)
    })
    rpcServer.registerMethod('plugin.storage.global.set', async (params) => {
      storage.set(params.pluginId as string, params.key as string, params.value)
    })
    rpcServer.registerMethod('plugin.storage.global.delete', async (params) => {
      storage.delete(params.pluginId as string, params.key as string)
    })
    rpcServer.registerMethod('plugin.storage.global.keys', async (params) => {
      return storage.keys(params.pluginId as string)
    })

    // 4. 通过事件触发激活
    await activator.handleEvent(
      { type: 'onStartupFinished' },
      host,
    )
    expect(activator.getState('hello-world')).toBe('ACTIVE')
    expect(activator.getActivePlugins()).toEqual(['hello-world'])

    // 5. 也可以通过 slash command 触发已激活的插件（幂等）
    await activator.handleEvent(
      { type: 'onSlashCommand', command: 'hello' },
      host,
    )
    expect(activator.getState('hello-world')).toBe('ACTIVE')

    // 6. 停用
    await activator.deactivatePlugin('hello-world', host)
    expect(activator.getState('hello-world')).toBe('UNLOADED')
    expect(activator.getActivePlugins().length).toBe(0)
  })

  // ── TC-int-02: storage round-trip through RPC ─────────────────
  it('TC-int-02: storage round-trip through RPC', async () => {
    // 通过 RPC 方法间接操作 storage
    const getMethod = async (pluginId: string, key: string) => {
      const handler = async (params: Record<string, unknown>) => {
        return storage.get(params.pluginId as string, params.key as string)
      }
      return handler({ pluginId, key })
    }
    const setMethod = async (pluginId: string, key: string, value: unknown) => {
      const handler = async (params: Record<string, unknown>) => {
        storage.set(params.pluginId as string, params.key as string, params.value)
      }
      await handler({ pluginId, key, value })
    }

    // 写入
    await setMethod('rpc-test', 'count', 42)
    await setMethod('rpc-test', 'label', 'hello')
    storage.flush('rpc-test')

    // 读取
    const count = await getMethod('rpc-test', 'count')
    expect(count).toBe(42)

    const label = await getMethod('rpc-test', 'label')
    expect(label).toBe('hello')

    // 新 storage 实例验证持久化
    const storage2 = new PluginStorage()
    await storage2.init(tmpDir, tmpDir)
    expect(await storage2.get('rpc-test', 'count')).toBe(42)
    expect(await storage2.get('rpc-test', 'label')).toBe('hello')
  })

  // ── TC-int-03: crash recovery ─────────────────────────────────
  it('TC-int-03: crash recovery — state reset after failed activation', async () => {
    const crashActivator = new PluginActivator()
    const desc = {
      pluginId: 'crash-plugin',
      version: '1.0.0',
      displayName: 'Crash Plugin',
      description: '',
      main: 'index.js',
      activationEvents: ['onStartupFinished'],
      trustLevel: 'sandbox' as const,
      status: 'UNLOADED' as const,
      contributes: {},
      permissions: [],
      engines: { 'xyz-agent': '*' },
      pluginPath: '/tmp/crash-plugin',
      source: 'external' as const,
      extensionDependencies: [],
    }
    crashActivator.registerDescriptors([desc])

    const rpc = new PluginRpcServer()

    // 模拟 Worker 在 activate 时回复 error
    const errorHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('crash-worker')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'crash-worker',
        postMessage: vi.fn(() => {
          queueMicrotask(() => {
            crashActivator.handleWorkerReply({
              type: 'error',
              pluginId,
              error: 'Worker crashed during activation',
            })
          })
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    // 激活失败
    await crashActivator.activatePlugin(
      'crash-plugin',
      { type: 'onStartupFinished' },
      errorHost,
    )

    // 状态应该是 UNLOADED（不是 ACTIVE）
    expect(crashActivator.getState('crash-plugin')).toBe('UNLOADED')
    expect(crashActivator.getActivePlugins().length).toBe(0)

    // 可以重新尝试激活（恢复）
    const recoveryHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('recovery-worker')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'recovery-worker',
        postMessage: vi.fn(() => {
          queueMicrotask(() => {
            crashActivator.handleWorkerReply({ type: 'activated', pluginId })
          })
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    await crashActivator.activatePlugin(
      'crash-plugin',
      { type: 'onStartupFinished' },
      recoveryHost,
    )
    expect(crashActivator.getState('crash-plugin')).toBe('ACTIVE')
  })
})
