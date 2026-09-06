/**
 * ConfigService 对话流式空闲超时配置单元测试（timeout-streaming-ui-idle §5.3 D3 配置链）。
 *
 * 覆盖 getStreamingIdleTimeout / setStreamingIdleTimeout：
 *  - 持久化：config.json.streamingIdleTimeout 字段写入，不覆盖其他字段
 *  - clamp 语义：合法域 [60, 3600] 秒，越界 clamp 到边界 + 返回生效值（区别于
 *    worktree setTimeout 的越界 throw——表单拦截为主，runtime clamp 是第二道防线）
 *  - 默认值 1800s；非有限值（NaN）回默认；存量脏数据（越界/非 number）读侧兜底
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/streaming-idle-config.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfigService } from '../config-service.js'
import type { IConfigStore } from '../ports/config.js'
import * as fsUtils from '../../utils/fs-utils.js'

// mock atomicWrite 避免真实磁盘写入
vi.mock('../../utils/fs-utils.js', () => ({
  atomicWrite: vi.fn(),
}))

// mock fs 模块，控制 existsSync / readFileSync / mkdirSync
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
  }
})

function createMockConfigStore(overrides: Partial<IConfigStore> = {}): IConfigStore {
  return {
    getDefaultModel: vi.fn(() => null),
    setDefaultModel: vi.fn(),
    readModels: vi.fn(() => ({ providers: {} })),
    getProviderConfig: vi.fn(() => undefined),
    upsertProvider: vi.fn(() => ({})),
    removeProvider: vi.fn(() => ({ removed: false })),
    applyTypeTranslation: vi.fn((t: string) => t),
    addSkillPath: vi.fn(),
    removeSkillPath: vi.fn(),
    setSkillPaths: vi.fn(),
    getSkillPaths: vi.fn(() => []),
    getSkillPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
    getAgentDirs: vi.fn(() => []),
    getAgentPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
    setAgentDirs: vi.fn(),
    getExtensionDirs: vi.fn(() => []),
    getExtensionPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
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

describe('ConfigService streaming idle timeout（§5.3 D3）', () => {
  let configService: ConfigService
  let mockStore: IConfigStore
  let fs: typeof import('node:fs')
  let writtenConfig: Record<string, unknown> | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    fs = await import('node:fs')
    writtenConfig = undefined
    // atomicWrite 捕获写入内容
    vi.mocked(fsUtils.atomicWrite).mockImplementation((_path, data) => {
      writtenConfig = JSON.parse(data as string)
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('{}')
    mockStore = createMockConfigStore()
    configService = new ConfigService('/tmp/project', mockStore)
  })

  describe('getStreamingIdleTimeout', () => {
    it('config.json 无该字段时返回默认 1800 秒', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}')
      expect(configService.getStreamingIdleTimeout()).toBe(1800)
    })

    it('返回 config.json 中的 streamingIdleTimeout 值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: 300 }))
      expect(configService.getStreamingIdleTimeout()).toBe(300)
    })

    it('字段非 number 时返回默认值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: '300' }))
      expect(configService.getStreamingIdleTimeout()).toBe(1800)
    })

    it('存量脏数据越界时读侧 clamp（下界）', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: 5 }))
      expect(configService.getStreamingIdleTimeout()).toBe(60)
    })

    it('存量脏数据越界时读侧 clamp（上界）', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: 9999 }))
      expect(configService.getStreamingIdleTimeout()).toBe(3600)
    })
  })

  describe('setStreamingIdleTimeout', () => {
    it('写入 streamingIdleTimeout 到 config.json 并返回生效值', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ toolPermissions: { bash: 'allow' } }))
      const effective = configService.setStreamingIdleTimeout(300)
      expect(effective).toBe(300)
      expect(writtenConfig).toEqual({
        toolPermissions: { bash: 'allow' },
        streamingIdleTimeout: 300,
      })
    })

    it('不覆盖 config.json 已有其他字段', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ streamingIdleTimeout: 1800, defaultBaseBranch: 'origin/main' }))
      configService.setStreamingIdleTimeout(600)
      expect(writtenConfig).toEqual({
        streamingIdleTimeout: 600,
        defaultBaseBranch: 'origin/main',
      })
    })

    it('低于下界 clamp 到 60 秒（返回生效值，不 throw）', () => {
      const effective = configService.setStreamingIdleTimeout(10)
      expect(effective).toBe(60)
      expect(writtenConfig?.['streamingIdleTimeout']).toBe(60)
    })

    it('高于上界 clamp 到 3600 秒（返回生效值，不 throw）', () => {
      const effective = configService.setStreamingIdleTimeout(7200)
      expect(effective).toBe(3600)
      expect(writtenConfig?.['streamingIdleTimeout']).toBe(3600)
    })

    it('边界值 60 / 3600 原样接受', () => {
      expect(configService.setStreamingIdleTimeout(60)).toBe(60)
      expect(configService.setStreamingIdleTimeout(3600)).toBe(3600)
    })

    it('NaN 等非有限值回默认 1800（clamp 对 NaN 无意义，宁取默认不落脏数据）', () => {
      const effective = configService.setStreamingIdleTimeout(Number.NaN)
      expect(effective).toBe(1800)
      expect(writtenConfig?.['streamingIdleTimeout']).toBe(1800)
    })
  })
})
