import { describe, it, expect, vi } from 'vitest'

import { PluginActivator } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginHost as ActivatorHost } from '../src/services/plugin-service/plugin-activator.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'test-plugin',
    version: '1.0.0',
    displayName: 'Test Plugin',
    description: '',
    main: 'index.js',
    activationEvents: ['onStartupFinished'],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'xyz-agent': '*' },
    pluginPath: '/tmp/test-plugin',
    source: 'external',
    extensionDependencies: [],
    ...overrides,
  }
}

/**
 * 创建 mock PluginHost。
 * postMessage 被调用后，在 microtask 中通过 activator.handleWorkerReply 模拟 Worker 回复。
 */
function createMockHost(
  activator: PluginActivator,
  replyType: 'activated' | 'deactivated' = 'activated',
): ActivatorHost {
  let currentPluginId = 'test-plugin'

  return {
    assignWorker: vi.fn((_pluginId: string, _trustLevel: 'trusted' | 'sandbox') => {
      return Promise.resolve('worker-1')
    }),
    loadPlugin: vi.fn((_workerId: string, _pluginPath: string) => {
      return Promise.resolve()
    }),
    getWorkerHandle: vi.fn((pluginId: string) => {
      currentPluginId = pluginId
      return {
        workerId: 'worker-1',
        postMessage: vi.fn(() => {
          // 模拟 Worker 回复
          queueMicrotask(() => {
            activator.handleWorkerReply({
              type: replyType,
              pluginId,
            })
          })
        }),
      }
    }),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}

describe('PluginActivator', () => {
  // ── TC-4-01: registerDescriptors builds eventMap ──────────────
  it('TC-4-01: registerDescriptors builds eventMap and handles getActivePlugins', () => {
    const activator = new PluginActivator()
    const desc1 = makeDescriptor({
      pluginId: 'p1',
      activationEvents: ['onStartupFinished', 'onSlashCommand:hello'],
    })
    const desc2 = makeDescriptor({
      pluginId: 'p2',
      activationEvents: ['onSlashCommand:hello'],
    })

    activator.registerDescriptors([desc1, desc2])

    // 注册后，两个插件都应处于 UNLOADED 状态
    expect(activator.getState('p1')).toBe('UNLOADED')
    expect(activator.getState('p2')).toBe('UNLOADED')
    expect(activator.getActivePlugins().length).toBe(0)
  })

  // ── TC-4-02: handleEvent matches activationEvents ─────────────
  it('TC-4-02: handleEvent matches activationEvents', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'slash-plugin',
      activationEvents: ['onSlashCommand:hello'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    // 匹配的事件应触发激活
    await activator.handleEvent(
      { type: 'onSlashCommand', command: 'hello' },
      host,
    )

    // 激活流程完成（mock host 立即回复 'activated'）
    expect(activator.getState('slash-plugin')).toBe('ACTIVE')
  })

  // ── TC-4-03: activatePlugin sets state to ACTIVE ──────────────
  it('TC-4-03: activatePlugin sets state to ACTIVE', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'act-test' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    expect(activator.getState('act-test')).toBe('UNLOADED')

    await activator.activatePlugin('act-test', { type: 'onStartupFinished' }, host)

    expect(activator.getState('act-test')).toBe('ACTIVE')
    expect(activator.getActivePlugins()).toEqual(['act-test'])
  })

  // ── TC-4-04: deactivatePlugin sets state to UNLOADED ──────────
  it('TC-4-04: deactivatePlugin sets state to UNLOADED', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'deact-test' })
    activator.registerDescriptors([desc])

    // 先激活
    const activateHost = createMockHost(activator, 'activated')
    await activator.activatePlugin('deact-test', { type: 'onStartupFinished' }, activateHost)
    expect(activator.getState('deact-test')).toBe('ACTIVE')

    // 再停用
    const deactivateHost = createMockHost(activator, 'deactivated')
    await activator.deactivatePlugin('deact-test', deactivateHost)
    expect(activator.getState('deact-test')).toBe('UNLOADED')
    expect(activator.getActivePlugins().length).toBe(0)
  })

  // ── 幂等：重复激活应跳过 ──────────────────────────────────────
  it('activatePlugin is idempotent (skip if already ACTIVE)', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'idempotent-test' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    await activator.activatePlugin('idempotent-test', { type: 'onStartupFinished' }, host)
    expect(activator.getState('idempotent-test')).toBe('ACTIVE')

    // 第二次激活应直接跳过（assignWorker 不应被再次调用）
    const assignCallsBefore = (host.assignWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    await activator.activatePlugin('idempotent-test', { type: 'onStartupFinished' }, host)
    const assignCallsAfter = (host.assignWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(assignCallsAfter).toBe(assignCallsBefore)
  })

  // ── Worker 回复 error 时状态应为 UNLOADED ─────────────────────
  it('activatePlugin sets UNLOADED when worker replies error', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'error-test' })
    activator.registerDescriptors([desc])

    // 创建一个 host，其 postMessage 触发 error 回复
    const errorHost: ActivatorHost = {
      assignWorker: vi.fn(() => Promise.resolve('worker-1')),
      loadPlugin: vi.fn(() => Promise.resolve()),
      getWorkerHandle: vi.fn((pluginId: string) => ({
        workerId: 'worker-1',
        postMessage: vi.fn(() => {
          queueMicrotask(() => {
            activator.handleWorkerReply({
              type: 'error',
              pluginId,
              error: 'activation failed',
            })
          })
        }),
      })),
      terminateWorker: vi.fn(() => Promise.resolve()),
    }

    await activator.activatePlugin('error-test', { type: 'onStartupFinished' }, errorHost)
    expect(activator.getState('error-test')).toBe('UNLOADED')
  })

  // ── deactivatePlugin 对未激活插件是 no-op ─────────────────────
  it('deactivatePlugin is no-op for UNLOADED plugins', async () => {
    const activator = new PluginActivator()
    activator.registerDescriptors([makeDescriptor({ pluginId: 'no-op-test' })])

    const host = createMockHost(activator, 'deactivated')
    expect(activator.getState('no-op-test')).toBe('UNLOADED')

    await activator.deactivatePlugin('no-op-test', host)
    expect(activator.getState('no-op-test')).toBe('UNLOADED')
  })

  // ── deactivateAll 停用所有已激活插件 ──────────────────────────
  it('deactivateAll deactivates all active plugins', async () => {
    const activator = new PluginActivator()
    const desc1 = makeDescriptor({ pluginId: 'all-1', activationEvents: ['onStartupFinished'] })
    const desc2 = makeDescriptor({ pluginId: 'all-2', activationEvents: ['onStartupFinished'] })
    activator.registerDescriptors([desc1, desc2])

    const host1 = createMockHost(activator, 'activated')
    const host2 = createMockHost(activator, 'activated')

    await activator.activatePlugin('all-1', { type: 'onStartupFinished' }, host1)
    await activator.activatePlugin('all-2', { type: 'onStartupFinished' }, host2)
    expect(activator.getActivePlugins().length).toBe(2)

    const deactHost = createMockHost(activator, 'deactivated')
    await activator.deactivateAll(deactHost)
    expect(activator.getActivePlugins().length).toBe(0)
    expect(activator.getState('all-1')).toBe('UNLOADED')
    expect(activator.getState('all-2')).toBe('UNLOADED')
  })

  // ── handleEvent 不匹配时不会激活 ──────────────────────────────
  it('handleEvent does not activate when event does not match', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({
      pluginId: 'no-match',
      activationEvents: ['onSlashCommand:hello'],
    })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    await activator.handleEvent(
      { type: 'onSlashCommand', command: 'other' },
      host,
    )

    expect(activator.getState('no-match')).toBe('UNLOADED')
  })

  // ── 未知插件 activatePlugin 是 no-op ─────────────────────────
  it('activatePlugin is no-op for unknown pluginId', async () => {
    const activator = new PluginActivator()
    const host = createMockHost(activator, 'activated')

    await activator.activatePlugin('nonexistent', { type: 'onStartupFinished' }, host)
    expect(activator.getState('nonexistent')).toBe(undefined)
  })
})
