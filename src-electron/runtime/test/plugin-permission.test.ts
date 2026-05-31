/**
 * Task 3 测试: PermissionChecker + PermissionStorage
 *
 * 验证插件权限管理的核心逻辑：
 * - trusted 插件 check() 始终 true
 * - sandbox 插件未授权 check() 返回 false
 * - grant() 后 check() 返回 true
 * - revoke() 后 check() 返回 false
 * - load() 文件不存在时初始化空 map
 * - save() + load() 往返正确
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginPermissionChecker } from '../src/services/plugin-service/plugin-permission.js'
import { PermissionStorage } from '../src/services/plugin-service/plugin-permission-storage.js'
import type { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'

let tmpDir: string

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'test-plugin',
    version: '1.0.0',
    displayName: 'Test',
    description: '',
    main: 'index.js',
    activationEvents: [],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'xyz-agent': '*' },
    pluginPath: '/tmp/test',
    source: 'external',
    extensionDependencies: [],
    ...overrides,
  }
}

function createMockRegistry(descriptors: PluginDescriptor[]): PluginRegistry {
  const map = new Map(descriptors.map(d => [d.pluginId, d]))
  return {
    getDescriptor: (id: string) => map.get(id),
  } as unknown as PluginRegistry
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-permission-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('Task 3: PermissionChecker', () => {
  describe('trusted plugin', () => {
    it('check() always returns true for trusted plugins', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'trusted-1', trustLevel: 'trusted', source: 'built-in' }),
      ])
      const checker = new PluginPermissionChecker(registry)

      expect(checker.check('trusted-1', 'tools.register')).toBe(true)
      expect(checker.check('trusted-1', 'hooks.register')).toBe(true)
      expect(checker.check('trusted-1', 'any.method')).toBe(true)
    })

    it('check() returns true regardless of granted permissions for trusted', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'trusted-2', trustLevel: 'trusted' }),
      ])
      const checker = new PluginPermissionChecker(registry)

      // 即使没 grant，trusted 也能通过
      expect(checker.check('trusted-2', 'tools.register')).toBe(true)
    })
  })

  describe('sandbox plugin', () => {
    it('check() returns false when not authorized', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'sandbox-1', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry)

      expect(checker.check('sandbox-1', 'tools.register')).toBe(false)
    })

    it('check() returns true after grant()', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'sandbox-2', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry)

      checker.grant('sandbox-2', ['tools.register', 'hooks.register'])
      expect(checker.check('sandbox-2', 'tools.register')).toBe(true)
      expect(checker.check('sandbox-2', 'hooks.register')).toBe(true)
    })

    it('check() returns false for non-granted methods', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'sandbox-3', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry)

      checker.grant('sandbox-3', ['tools.register'])
      expect(checker.check('sandbox-3', 'tools.register')).toBe(true)
      expect(checker.check('sandbox-3', 'hooks.register')).toBe(false)
    })

    it('check() returns false after revoke()', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'sandbox-4', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry)

      checker.grant('sandbox-4', ['tools.register'])
      expect(checker.check('sandbox-4', 'tools.register')).toBe(true)

      checker.revoke('sandbox-4')
      expect(checker.check('sandbox-4', 'tools.register')).toBe(false)
    })

    it('revoke() on unknown pluginId is no-op', () => {
      const registry = createMockRegistry([])
      const checker = new PluginPermissionChecker(registry)

      // 不应抛异常
      checker.revoke('nonexistent')
    })

    it('check() returns false for unknown pluginId', () => {
      const registry = createMockRegistry([])
      const checker = new PluginPermissionChecker(registry)

      expect(checker.check('nonexistent', 'tools.register')).toBe(false)
    })

    it('grant() appends to existing permissions', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'sandbox-5', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry)

      checker.grant('sandbox-5', ['tools.register'])
      checker.grant('sandbox-5', ['hooks.register'])

      expect(checker.check('sandbox-5', 'tools.register')).toBe(true)
      expect(checker.check('sandbox-5', 'hooks.register')).toBe(true)
    })
  })
})

describe('Task 3: PermissionStorage', () => {
  it('load() initializes empty map when file does not exist', async () => {
    const storage = new PermissionStorage(join(tmpDir, 'nonexistent-dir'))
    const map = await storage.load()

    expect(map instanceof Map).toBeTruthy()
    expect(map.size).toBe(0)
  })

  it('save() + load() round-trip preserves data', async () => {
    const dir = join(tmpDir, 'perm-storage')
    await mkdir(dir, { recursive: true })
    const storage = new PermissionStorage(dir)

    const data = new Map<string, string[]>()
    data.set('plugin-a', ['tools.register', 'hooks.register'])
    data.set('plugin-b', ['sessions.sendMessage'])

    await storage.save(data)

    const loaded = await storage.load()
    expect(loaded.size).toBe(2)
    expect(loaded.get('plugin-a')).toEqual(['tools.register', 'hooks.register'])
    expect(loaded.get('plugin-b')).toEqual(['sessions.sendMessage'])
  })

  it('save() overwrites previous data', async () => {
    const dir = join(tmpDir, 'perm-storage-2')
    await mkdir(dir, { recursive: true })
    const storage = new PermissionStorage(dir)

    const data1 = new Map<string, string[]>()
    data1.set('plugin-a', ['tools.register'])
    await storage.save(data1)

    const data2 = new Map<string, string[]>()
    data2.set('plugin-b', ['hooks.register'])
    await storage.save(data2)

    const loaded = await storage.load()
    expect(loaded.size).toBe(1)
    expect(loaded.get('plugin-b')).toEqual(['hooks.register'])
    expect(loaded.get('plugin-a')).toBe(undefined)
  })

  it('load() handles corrupted JSON gracefully', async () => {
    const dir = join(tmpDir, 'perm-storage-3')
    await mkdir(dir, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'permissions.json'), 'not valid json{{{', 'utf-8')

    const storage = new PermissionStorage(dir)
    const map = await storage.load()
    expect(map instanceof Map).toBeTruthy()
    expect(map.size).toBe(0)
  })
})
