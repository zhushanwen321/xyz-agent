/**
 * ConfigService config CAS（P6 D3）单元测试。
 *
 * 覆盖 setProvider/deleteProvider 的 expectedVersion 乐观锁：
 * - 匹配成功 → version 自增（newVersion 返回）
 * - 不匹配 → 抛 VersionConflictError（currentVersion 透传）
 * - deleteProvider 走同模式
 * - 旧 models.json 无 version 字段 → default 0
 *
 * 走 mock IConfigStore（隔离 pi-provider-store 真实文件 IO），验证 facade 层 CAS 逻辑。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfigService, VersionConflictError } from '../config-service.js'
import type { IConfigStore } from '../ports/config.js'
import type { ConfigModelsConfig } from '../ports/config.js'

// mock atomicWrite 避免真实磁盘写入
vi.mock('../../utils/fs-utils.js', () => ({
  atomicWrite: vi.fn(),
}))

function createMockConfigStore(overrides: Partial<IConfigStore> = {}): IConfigStore {
  return {
    getDefaultModel: vi.fn(() => null),
    setDefaultModel: vi.fn(),
    readModels: vi.fn(() => ({ providers: {} }) as ConfigModelsConfig),
    bumpModelsVersion: vi.fn(() => 1),
    getProviderConfig: vi.fn(() => undefined),
    upsertProvider: vi.fn(() => ({})),
    removeProvider: vi.fn(() => ({ removed: false })),
    applyTypeTranslation: vi.fn((t: string) => t),
    addSkillPath: vi.fn(),
    removeSkillPath: vi.fn(),
    setSkillPaths: vi.fn(),
    getSkillPaths: vi.fn(() => []),
    getAgentDirs: vi.fn(() => []),
    setAgentDirs: vi.fn(),
    getExtensionDirs: vi.fn(() => []),
    setExtensionDirs: vi.fn(),
    listAgentFiles: vi.fn(() => []),
    writeAgentFile: vi.fn(),
    deleteAgentFile: vi.fn(),
    migrateSettingsSkillsToDiscovery: vi.fn(),
    getPiAgentDir: vi.fn(() => '/tmp/pi-agent'),
    getConfigDir: vi.fn(() => '/tmp/test-config'),
    ...overrides,
  } as IConfigStore
}

describe('ConfigService config CAS (P6 D3)', () => {
  let configService: ConfigService
  let mockStore: IConfigStore

  beforeEach(() => {
    mockStore = createMockConfigStore()
    configService = new ConfigService('/tmp/test-root', mockStore)
  })

  describe('setProvider CAS', () => {
    it('TC1: expectedVersion 匹配（旧文件无 version default 0）时成功且 version 自增', () => {
      // 旧文件无 version 字段 → readModels 返回 {providers:{}} 无 version → currentVersion ?? 0 = 0
      ;(mockStore.readModels as ReturnType<typeof vi.fn>).mockReturnValue({ providers: {} })
      ;(mockStore.bumpModelsVersion as ReturnType<typeof vi.fn>).mockReturnValue(1)
      ;(mockStore.upsertProvider as ReturnType<typeof vi.fn>).mockReturnValue({})

      const result = configService.setProvider('p1', { name: 'P1', apiKey: 'k' }, 0)

      expect(mockStore.upsertProvider).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'P1', apiKey: 'k' }))
      expect(mockStore.bumpModelsVersion).toHaveBeenCalledTimes(1)
      expect(result.newVersion).toBe(1)
    })

    it('TC2: expectedVersion 不匹配时抛 VersionConflictError 且不调 upsert', () => {
      ;(mockStore.readModels as ReturnType<typeof vi.fn>).mockReturnValue({ providers: {}, version: 1 })

      expect(() => configService.setProvider('p1', { name: 'X' }, 0)).toThrow(VersionConflictError)
      expect(() => configService.setProvider('p1', { name: 'X' }, 0)).toThrow(/version conflict/)

      // 重置 call 计数后验证 upsert 未被调（冲突路径直接抛错）
      ;(mockStore.upsertProvider as ReturnType<typeof vi.fn>).mockClear()
      ;(mockStore.bumpModelsVersion as ReturnType<typeof vi.fn>).mockClear()
      try {
        configService.setProvider('p1', { name: 'X' }, 0)
      } catch {
        // expected
      }
      expect(mockStore.upsertProvider).not.toHaveBeenCalled()
      expect(mockStore.bumpModelsVersion).not.toHaveBeenCalled()
    })

    it('TC2b: VersionConflictError.currentVersion 透传当前版本', () => {
      ;(mockStore.readModels as ReturnType<typeof vi.fn>).mockReturnValue({ providers: {}, version: 2 })

      try {
        configService.setProvider('p1', { name: 'X' }, 0)
        throw new Error('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(VersionConflictError)
        expect((e as VersionConflictError).currentVersion).toBe(2)
        expect((e as VersionConflictError).code).toBe('version_conflict')
      }
    })

    it('TC2c: expectedVersion 匹配非零版本时成功', () => {
      ;(mockStore.readModels as ReturnType<typeof vi.fn>).mockReturnValue({ providers: {}, version: 5 })
      ;(mockStore.bumpModelsVersion as ReturnType<typeof vi.fn>).mockReturnValue(6)
      ;(mockStore.upsertProvider as ReturnType<typeof vi.fn>).mockReturnValue({})

      const result = configService.setProvider('p1', { name: 'P1' }, 5)

      expect(result.newVersion).toBe(6)
      expect(mockStore.upsertProvider).toHaveBeenCalledTimes(1)
    })
  })

  describe('deleteProvider CAS', () => {
    it('TC3: expectedVersion 匹配且 provider 存在时删除成功 + version 自增', () => {
      ;(mockStore.readModels as ReturnType<typeof vi.fn>).mockReturnValue({ providers: { p1: {} }, version: 0 })
      ;(mockStore.bumpModelsVersion as ReturnType<typeof vi.fn>).mockReturnValue(1)
      ;(mockStore.removeProvider as ReturnType<typeof vi.fn>).mockReturnValue({ removed: true })

      const result = configService.deleteProvider('p1', 0)

      expect(mockStore.removeProvider).toHaveBeenCalledWith('p1')
      expect(mockStore.bumpModelsVersion).toHaveBeenCalledTimes(1)
      expect(result.removed).toBe(true)
      expect(result.newVersion).toBe(1)
    })

    it('TC3b: expectedVersion 不匹配时抛 VersionConflictError', () => {
      ;(mockStore.readModels as ReturnType<typeof vi.fn>).mockReturnValue({ providers: { p1: {} }, version: 3 })

      expect(() => configService.deleteProvider('p1', 0)).toThrow(VersionConflictError)
      expect(mockStore.removeProvider).not.toHaveBeenCalled()
    })

    it('TC3c: provider 不存在（removed=false）时不自增 version', () => {
      ;(mockStore.readModels as ReturnType<typeof vi.fn>).mockReturnValue({ providers: {}, version: 0 })
      ;(mockStore.removeProvider as ReturnType<typeof vi.fn>).mockReturnValue({ removed: false })

      const result = configService.deleteProvider('nope', 0)

      expect(result.removed).toBe(false)
      expect(result.newVersion).toBe(0) // 不自增，保持 currentVersion
      expect(mockStore.bumpModelsVersion).not.toHaveBeenCalled()
    })
  })

  describe('getConfigVersion', () => {
    it('旧文件无 version 字段返回 0', () => {
      ;(mockStore.readModels as ReturnType<typeof vi.fn>).mockReturnValue({ providers: {} })
      expect(configService.getConfigVersion()).toBe(0)
    })

    it('有 version 字段返回实际值', () => {
      ;(mockStore.readModels as ReturnType<typeof vi.fn>).mockReturnValue({ providers: {}, version: 7 })
      expect(configService.getConfigVersion()).toBe(7)
    })
  })
})
