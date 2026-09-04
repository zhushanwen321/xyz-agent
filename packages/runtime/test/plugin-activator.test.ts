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
    // 默认 built-in：正常激活路径 fixture（激活锁只锁 external，见下方锁语义 describe）。
    // 锁语义用例显式传 source: 'external'。
    source: 'built-in',
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

describe('external plugin activation hard lock（§6.6 激活侧，IF3）', () => {
  // ── TC-A: external + 开关 true（sandbox 闭环已落地）→ 正常激活 ────────
  it('TC-A: external plugin + EXTERNAL_PLUGIN_ENABLED=true（翻转后）→ 正常激活 (assignWorker called, state ACTIVE)', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'ext-allowed', source: 'external' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    // 翻转后：external 来源不再被硬锁跳过（sandbox 子进程 + ESM loader 兜底隔离，
    // 见 plugin-security.ts [翻转记录]）。开关回退 false 时本 guard 重新生效（fail-closed）。
    await activator.activatePlugin('ext-allowed', { type: 'onStartupFinished' }, host)

    // 正常进入激活路径
    expect(activator.getState('ext-allowed')).toBe('ACTIVE')
    expect(host.assignWorker).toHaveBeenCalledTimes(1)
    expect(host.loadPlugin).toHaveBeenCalledTimes(1)
  })

  // ── TC-B: built-in 来源不受影响，正常激活 ─────────────────────
  it('TC-B: built-in plugin unaffected → normal activation path (assignWorker called, state ACTIVE)', async () => {
    const activator = new PluginActivator()
    const desc = makeDescriptor({ pluginId: 'builtin-ok', source: 'built-in' })
    activator.registerDescriptors([desc])

    const host = createMockHost(activator, 'activated')

    await activator.activatePlugin('builtin-ok', { type: 'onStartupFinished' }, host)

    expect(activator.getState('builtin-ok')).toBe('ACTIVE')
    expect(host.assignWorker).toHaveBeenCalled()
    expect(host.loadPlugin).toHaveBeenCalled()
  })
})

/**
 * 沉默 host：postMessage 后 Worker 不回复（activate 超时路径用——回复型 mock 会在
 * microtask 内 resolve，永远走不到超时 timer）。
 */
function createSilentHost(): ActivatorHost {
  return {
    assignWorker: vi.fn(() => Promise.resolve('worker-1')),
    loadPlugin: vi.fn(() => Promise.resolve()),
    getWorkerHandle: vi.fn(() => ({
      workerId: 'worker-1',
      postMessage: vi.fn(),
    })),
    terminateWorker: vi.fn(() => Promise.resolve()),
  }
}

describe('activate 超时覆盖参数（timeout-plugin-service D4：控制面 30s 保持 + activateTimeoutMs 逃生门）', () => {
  it('activateTimeoutMs 覆盖生效：注入小值后超时 → UNLOADED + warn 含 activateTimeoutMs 覆盖指引', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const activator = new PluginActivator({ activateTimeoutMs: 100 })
      const desc = makeDescriptor({ pluginId: 'slow-activate' })
      activator.registerDescriptors([desc])

      const host = createSilentHost()
      const pending = activator.activatePlugin('slow-activate', { type: 'onStartupFinished' }, host)

      await vi.advanceTimersByTimeAsync(100)
      await pending

      expect(activator.getState('slow-activate')).toBe('UNLOADED')
      const warns = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
        .filter((msg: string) => msg.includes('activate reply'))
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('timed out after 100ms')
      expect(warns[0]).toContain('activateTimeoutMs')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('默认 30s 回归：未传 activateTimeoutMs 时 29_999ms 仍等待、30_000ms 超时 UNLOADED', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      const desc = makeDescriptor({ pluginId: 'default-timeout' })
      activator.registerDescriptors([desc])

      const host = createSilentHost()
      const pending = activator.activatePlugin('default-timeout', { type: 'onStartupFinished' }, host)

      await vi.advanceTimersByTimeAsync(29_999)
      expect(activator.getState('default-timeout')).toBe('ACTIVATING')

      await vi.advanceTimersByTimeAsync(1)
      await pending

      expect(activator.getState('default-timeout')).toBe('UNLOADED')
      expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
        .some((msg: string) => msg.includes('timed out after 30000ms'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('deactivate 超时不打 activateTimeoutMs 指引（D6 登记不动项维持静默）', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const activator = new PluginActivator()
      const desc = makeDescriptor({ pluginId: 'silent-deact' })
      activator.registerDescriptors([desc])

      // 先用回复型 host 激活成功，再换沉默 host 停用（deactivate 回复永不到达）
      await activator.activatePlugin('silent-deact', { type: 'onStartupFinished' }, createMockHost(activator, 'activated'))
      expect(activator.getState('silent-deact')).toBe('ACTIVE')

      const pending = activator.deactivatePlugin('silent-deact', createSilentHost())
      await vi.advanceTimersByTimeAsync(5_000)
      await pending

      // deactivate 超时（5s）后仍完成本地清理（D6 现状），且无 activate 超时类 warn
      expect(activator.getState('silent-deact')).toBe('UNLOADED')
      expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
        .some((msg: string) => msg.includes('activateTimeoutMs'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('超时后迟到的 activated 回复 miss noop：状态不被复活', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const activator = new PluginActivator({ activateTimeoutMs: 50 })
      const desc = makeDescriptor({ pluginId: 'late-reply' })
      activator.registerDescriptors([desc])

      // postMessage 后手动控制回复时机：超时到期后再补发 activated 回复
      let posted = false
      const host: ActivatorHost = {
        assignWorker: vi.fn(() => Promise.resolve('worker-1')),
        loadPlugin: vi.fn(() => Promise.resolve()),
        getWorkerHandle: vi.fn((pluginId: string) => ({
          workerId: 'worker-1',
          postMessage: vi.fn(() => { posted = true }),
        })),
        terminateWorker: vi.fn(() => Promise.resolve()),
      }
      const pending = activator.activatePlugin('late-reply', { type: 'onStartupFinished' }, host)

      await vi.advanceTimersByTimeAsync(50)
      await pending
      expect(activator.getState('late-reply')).toBe('UNLOADED')

      // 迟到的 activated 回复：pending 已删，miss noop，状态不复活
      expect(posted).toBe(true)
      activator.handleWorkerReply({ type: 'activated', pluginId: 'late-reply' })
      expect(activator.getState('late-reply')).toBe('UNLOADED')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
