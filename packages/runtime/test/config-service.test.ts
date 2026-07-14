/**
 * ConfigService — runtime enabled 读写链路（W2）端到端单测。
 *
 * 用真实 PiConfigStore（指向临时目录的 models.json）验证：
 * U1 listProviders 返回 provider 级 api 字段（修复编辑回填丢失 api，P0-1）+ enabled
 * U2 setProvider 写入 enabled 并被 listProviders 读回（真实读写 models.json，非硬编码）
 * U3 setProvider 写入 model 级 enabled 并被 aggregateModels 过滤（在 model-service.test.ts 验证过滤逻辑，
 *    此处只验证 listProviders 读回 model 级 enabled 字段）
 *
 * setup 模式复用 pi-provider-store.test.ts：setModelsPath/setSettingsPath 指向临时目录 +
 * writeModels 落盘 + refreshModels 刷缓存。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import {
  writeModels,
  refreshModels,
  setModelsPath,
  type PiModelsConfig,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string
let configService: ConfigService

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'config-service-test-'))
  mkdirSync(join(tmpDir, 'pi', 'agent'), { recursive: true })
  // 指向临时目录，避免污染真实 ~/.xyz-agent/pi/agent
  setModelsPath(join(tmpDir, 'pi', 'agent', 'models.json'))
  setSettingsPath(join(tmpDir, 'pi', 'agent', 'settings.json'))
  refreshModels()
  // ConfigService 接受 IConfigStore；用真实 PiConfigStore 走完整读写链路
  const configStore = new PiConfigStore()
  configService = new ConfigService(tmpDir, configStore)
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})

// ── U1: listProviders 返回 provider 级 api 字段 ────────────────────
// 修复编辑回填丢失 api：前端编辑 provider 时需用 api 字段回填 type 下拉，
// listProviders 不返回 api 会导致编辑后 type 丢失（P0-1）。
describe('ConfigService.listProviders · provider 级 api 字段（U1，修复 P0-1）', () => {
  it('返回 provider 的 api 字段（非 undefined）', () => {
    const models: PiModelsConfig = {
      providers: {
        p1: {
          api: 'anthropic-messages',
          apiKey: 'sk-x',
          enabled: true,
          models: [],
        },
      },
    }
    writeModels(models)
    refreshModels()

    const providers = configService.listProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0]!.id).toBe('p1')
    // 关键断言：api 字段必须回填，否则前端编辑 provider 时 type 下拉丢失
    expect(providers[0]!.api).toBe('anthropic-messages')
  })

  it('enabled=true 的 provider 返回 enabled === true', () => {
    const models: PiModelsConfig = {
      providers: {
        p1: {
          apiKey: 'sk-x',
          enabled: true,
          models: [],
        },
      },
    }
    writeModels(models)
    refreshModels()

    const providers = configService.listProviders()
    expect(providers[0]!.enabled).toBe(true)
  })
})

// ── U2: setProvider 写入 enabled 并被 listProviders 读回 ────────────
// 验证真实读写 models.json：setProvider 落盘 enabled → listProviders 从盘读回。
// 关键：测的是写盘持久化链路，不是内存硬编码。
describe('ConfigService.setProvider · provider 级 enabled 读写链路（U2）', () => {
  it('setProvider({ enabled: false }) 后 listProviders 读回 enabled === false', () => {
    // 先建一个 enabled:true 的 provider
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          enabled: true,
          models: [{ id: 'm1', name: 'M1' }],
        },
      },
    })
    refreshModels()

    // 写入 enabled:false
    configService.setProvider('p1', { enabled: false })

    const providers = configService.listProviders()
    expect(providers[0]!.enabled).toBe(false)
  })

  it('setProvider({ enabled: true }) 后 listProviders 读回 enabled === true', () => {
    // 先建一个 enabled:false 的 provider
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          enabled: false,
          models: [{ id: 'm1', name: 'M1' }],
        },
      },
    })
    refreshModels()

    // 写入 enabled:true
    configService.setProvider('p1', { enabled: true })

    const providers = configService.listProviders()
    expect(providers[0]!.enabled).toBe(true)
  })

  it('盘上 models.json 确实持久化了 enabled 字段（端到端非硬编码）', () => {
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          models: [{ id: 'm1' }],
        },
      },
    })
    refreshModels()

    configService.setProvider('p1', { enabled: false })
    refreshModels()

    // 直接读盘验证（绕过 service 缓存）
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 动态读盘验证
    const raw = require('node:fs').readFileSync(
      join(tmpDir, 'pi', 'agent', 'models.json'),
      'utf-8',
    )
    const parsed = JSON.parse(raw) as PiModelsConfig
    expect(parsed.providers.p1?.enabled).toBe(false)
  })
})

// ── 向上兼容：存量 provider 无 enabled 字段时默认视为启用 ──────────
// config.enabled !== false 语义：undefined 和 true 都视为启用，
// 只有显式 false 才禁用（向上兼容存量无此字段的 provider）。
describe('ConfigService.listProviders · 向上兼容（无 enabled 字段默认 true）', () => {
  it('存量 provider 无 enabled 字段时 enabled === true（向上兼容）', () => {
    // 故意不写 enabled 字段（模拟存量 models.json）
    const models: PiModelsConfig = {
      providers: {
        legacy: {
          apiKey: 'sk-legacy',
          models: [{ id: 'm1' }],
        },
      },
    }
    writeModels(models)
    refreshModels()

    const providers = configService.listProviders()
    expect(providers[0]!.enabled).toBe(true)
  })
})

// ── U3 前置：listProviders 读回 model 级 enabled（aggregateModels 过滤在 model-service.test.ts 验证）──
describe('ConfigService.listProviders · model 级 enabled 透传', () => {
  it('model 级 enabled=false 透传到 listProviders 结果', () => {
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          models: [
            { id: 'm1', name: 'M1', enabled: false },
            { id: 'm2', name: 'M2', enabled: true },
          ],
        },
      },
    })
    refreshModels()

    const providers = configService.listProviders()
    const models = providers[0]!.models
    // model 级 enabled 透传，供 aggregateModels 过滤判断
    expect(models.find(m => m.id === 'm1')?.enabled).toBe(false)
    expect(models.find(m => m.id === 'm2')?.enabled).toBe(true)
  })
})

// ── U3b: setProvider 的 model 合并写路径必须保留传入的 enabled/api/baseUrl ──
// review 发现：setProvider 的 model 合并循环只写 name/contextWindow/input/thinkingLevelMap，
// 前端回传的 api/baseUrl/enabled 被丢弃。新模型（base={}）和编辑现有模型场景都会丢字段。
// 此 describe 走 setProvider 写路径（而非 writeModels 直写），断言字段真落盘。
describe('ConfigService.setProvider · model 级字段写路径（U3b，修复 review must_fix #1）', () => {
  it('新模型经 setProvider 保存后 enabled 字段落盘', () => {
    // 先建空 provider
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          models: [],
        },
      },
    })
    refreshModels()

    // setProvider 传入含 enabled 的 model（新模型，base={}）
    configService.setProvider('p1', {
      models: [
        { id: 'm1', enabled: false },
        { id: 'm2', enabled: true },
      ],
    })

    const providers = configService.listProviders()
    const models = providers[0]!.models
    expect(models.find(m => m.id === 'm1')?.enabled).toBe(false)
    expect(models.find(m => m.id === 'm2')?.enabled).toBe(true)
  })

  it('model 级 api/baseUrl 经 setProvider 保存后落盘（编辑场景）', () => {
    // 先建含 m1 的 provider（m1 无 api/baseUrl）
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          api: 'anthropic-messages',
          models: [{ id: 'm1', name: 'M1' }],
        },
      },
    })
    refreshModels()

    // 编辑 m1，补 model 级 api/baseUrl（覆盖 provider 默认）
    configService.setProvider('p1', {
      models: [
        { id: 'm1', name: 'M1', api: 'openai-completions', baseUrl: 'https://m1.example.com' },
      ],
    })

    const providers = configService.listProviders()
    const m1 = providers[0]!.models.find(m => m.id === 'm1')
    expect(m1?.api).toBe('openai-completions')
    expect(m1?.baseUrl).toBe('https://m1.example.com')
  })
})

// ── W1: loadAgents sourceType 必须随来源目录推断（不再恒 'pi'）──────
// 背景：config-service.loadAgents 旧版把每个 agent 硬编码 source/sourceType = 'pi'，
// 导致 Settings Agent 页按 Claude/Agents tab 过滤时永远空（即便文件来自 ~/.claude/agents）。
// W1 修复：agent-crud.listAgentFiles 扫描时按 discovered 目录 inferSourceType 填 sourceType，
// config-service.loadAgents 透传该字段。
// 这里 mock configStore.listAgentFiles 返回带不同 sourceType 的 entry，
// 验证 loadAgents 不再恒 pi，而是如实透传。
describe('ConfigService.loadAgents · sourceType 随来源推断（W1，修复 tab 过滤失效）', () => {
  /**
   * 构造一个最小 fake configStore：只实现 loadAgents 用到的方法。
   * listAgentFiles 按 mockFiles 返回（含 sourceType），其余方法返回安全空值。
   * 跳过真实 PiConfigStore 是为了隔离：本测只验证「f.sourceType → AgentInfo.sourceType 透传」，
   * 不关心目录扫描/去重逻辑（那部分在 agent-crud 层，由真实文件验证更合适）。
   */
  function makeFakeStore(
    mockFiles: Array<{ name: string; path: string; content: string; sourceType: string }>,
  ) {
    return {
      getPiAgentDir: () => '/fake/pi/agent',
      getAgentDirs: () => [] as string[],
      listAgentFiles: () => mockFiles,
      // 以下方法 loadAgents 不会触达，给空实现满足 ConfigService 构造签名
      getDefaultModel: () => null,
      setDefaultModel: () => undefined,
      readModels: () => ({ providers: {} }),
      getProviderConfig: () => undefined,
      upsertProvider: () => ({}),
      removeProvider: () => ({ removed: false }),
      applyTypeTranslation: (t: string) => t,
      getSkillPaths: () => [] as string[],
      setSkillPaths: () => undefined,
      addSkillPath: () => undefined,
      removeSkillPath: () => undefined,
      migrateSettingsSkillsToDiscovery: () => undefined,
      setAgentDirs: () => undefined,
      writeAgentFile: () => undefined,
      deleteAgentFile: () => false,
      getConfigDir: () => '/fake/config',
    }
  }

  it('claude 目录来源的 agent sourceType === "claude"（非 pi）', () => {
    const store = makeFakeStore([
      {
        name: 'code-review',
        path: '/home/u/.claude/agents/code-review.md',
        content: '---\nname: Code Review\n---\nreview code',
        sourceType: 'claude',
      },
    ])
    const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

    const agents = svc.loadAgents('/fake/project')
    expect(agents).toHaveLength(1)
    // 关键断言：sourceType 必须如实透传，不能恒 pi（否则 Claude tab 过滤失效）
    expect(agents[0]!.sourceType).toBe('claude')
    expect(agents[0]!.source).toBe('claude')
  })

  it('agents 目录来源的 agent sourceType === "agents"', () => {
    const store = makeFakeStore([
      {
        name: 'builder',
        path: '/home/u/.agents/agents/builder.md',
        content: '---\nname: Builder\n---\nbuild things',
        sourceType: 'agents',
      },
    ])
    const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

    const agents = svc.loadAgents('/fake/project')
    expect(agents[0]!.sourceType).toBe('agents')
    expect(agents[0]!.source).toBe('agents')
  })

  it('混合来源各自透传（claude / agents / pi 共存）', () => {
    const store = makeFakeStore([
      {
        name: 'reviewer',
        path: '/h/.claude/agents/reviewer.md',
        content: '---\nname: Reviewer\n---',
        sourceType: 'claude',
      },
      {
        name: 'planner',
        path: '/h/.agents/agents/planner.md',
        content: '---\nname: Planner\n---',
        sourceType: 'agents',
      },
      {
        name: 'default',
        path: '/h/.xyz-agent/pi/agent/agents/default.md',
        content: '---\nname: Default\n---',
        sourceType: 'pi',
      },
    ])
    const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

    const agents = svc.loadAgents('/fake/project')
    const byId = new Map(agents.map(a => [a.id, a]))
    expect(byId.get('reviewer')?.sourceType).toBe('claude')
    expect(byId.get('planner')?.sourceType).toBe('agents')
    expect(byId.get('default')?.sourceType).toBe('pi')
  })

  it('sourceType 缺失时兜底为 pi（向后兼容旧 entry 无此字段）', () => {
    // 旧版 agent-crud 不填 sourceType（字段缺失 = undefined，非空串）；
    // config-service 用 ?? 'pi' 兜底，避免 undefined 污染前端。
    // 注意：?? 只兜底 null/undefined，不兜底空串——而 inferSourceType 运行时
    // 至少返回 'custom'，不会产出空串，故这里只测 undefined 这条兜底路径。
    const store = makeFakeStore([
      {
        name: 'legacy',
        path: '/h/somewhere/legacy.md',
        content: '---\nname: Legacy\n---',
        sourceType: '',
      },
    ])
    // 模拟「字段缺失」：删除 sourceType（等价于旧 entry 无此字段）
    delete (store.listAgentFiles()[0] as { sourceType?: string }).sourceType
    const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

    const agents = svc.loadAgents('/fake/project')
    // undefined → 兜底 pi
    expect(agents[0]!.sourceType).toBe('pi')
    expect(agents[0]!.source).toBe('pi')
  })
})
