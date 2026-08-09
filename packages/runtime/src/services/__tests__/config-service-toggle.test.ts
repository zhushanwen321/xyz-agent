/**
 * toggleProviderEnabled + 边界守卫 + setProvider 停用 enabled 测试（wave3，provider-dual-system-r2::enabledmodels-dual-consume）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-toggle.test.ts
 *
 * 策略：
 *   - TC1/TC2/TC3/TC6：mock configStore，断言写方法调用路由（setEnabledModels vs clearEnabledModels、
 *     setProvider merged 不含 provider 级 enabled）。
 *   - TC4/TC7：状态化 mock（写反映到读），验证 defaultModel 重选 + listProviders 联动。
 *   - 边界3 持久化（CL2）：真实 pi-settings-store（临时 settings 文件），验证 clearEnabledModels
 *     后 settings.json 物理无 enabledModels key（JSON.stringify 丢弃 delete 后的 undefined）。
 *
 * 覆盖 design TC1-TC4/TC6/TC7 + CL1（toggle(true) 空白名单 no-op）+ setProvider 边界1 守卫。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import type { IConfigStore, ConfigModelsConfig, ConfigProviderConfig } from '../ports/config.js'
import type { AuthStorage } from '../auth/auth-storage.js'
// 真实 pi-settings-store（边界3 持久化验证用）
import { clearEnabledModels, ensureProviderInWhitelist, setEnabledModels, setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'

type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

interface StoreOpts {
  /** models.json providers（默认空）。 */
  models?: ConfigModelsConfig['providers']
  /** settings.json.enabledModels（默认空 = 全启用，DM3）。 */
  enabledModels?: string[]
  /** settings.json defaultProvider/defaultModel（默认 null）。 */
  defaultModel?: { provider: string; modelId: string } | null
  /** auth.json 顶层 providerId 列表（catalog 凭据源，listProviders 联动用）。 */
  authIds?: string[]
}

/**
 * 状态化 mock IConfigStore：写操作（setEnabledModels/clearEnabledModels/setDefaultModel/
 * ensureProviderInWhitelist/upsertProvider）反映到后续读（getEnabledModels/getDefaultModel/
 * readModels/getProviderConfig）。TC4 边界2 重选 + TC7 联动需要 read-after-write 一致性。
 */
function makeStore(opts: StoreOpts = {}) {
  let enabledModels = [...(opts.enabledModels ?? [])]
  let defaultModel = opts.defaultModel ?? null
  const models: ConfigModelsConfig['providers'] = opts.models ? JSON.parse(JSON.stringify(opts.models)) : {}
  return {
    readModels: vi.fn(() => ({ providers: models })),
    getEnabledModels: vi.fn(() => [...enabledModels]),
    getDefaultModel: vi.fn(() => defaultModel),
    getProviderConfig: vi.fn((id: string) => (id in models ? JSON.parse(JSON.stringify(models[id])) : undefined)),
    setEnabledModels: vi.fn((p: string[]) => { enabledModels = [...p] }),
    clearEnabledModels: vi.fn(() => { enabledModels = [] }),
    setDefaultModel: vi.fn((provider: string, modelId: string) => { defaultModel = { provider, modelId } }),
    ensureProviderInWhitelist: vi.fn((id: string) => {
      // 与 pi-provider-store.ensureProviderInWhitelist 同语义（状态化镜像，供 TC4/TC7 read-after-write）
      if (enabledModels.length === 0) return
      const pattern = `${id}/*`
      if (enabledModels.includes(pattern)) return
      enabledModels = [...enabledModels, pattern]
    }),
    upsertProvider: vi.fn((id: string, merged: ConfigProviderConfig) => {
      models[id] = merged
      return {}
    }),
    applyTypeTranslation: vi.fn((t: string) => t),
    removeProvider: vi.fn(() => ({ removed: true })),
  } as unknown as IConfigStore & {
    setEnabledModels: ReturnType<typeof vi.fn>
    clearEnabledModels: ReturnType<typeof vi.fn>
    setDefaultModel: ReturnType<typeof vi.fn>
    ensureProviderInWhitelist: ReturnType<typeof vi.fn>
    upsertProvider: ReturnType<typeof vi.fn>
  }
}

function makeAuth(authIds: string[] = []): FullAuthPick {
  return {
    listCredentialIds: vi.fn(() => authIds),
    hasCredentialSync: vi.fn(() => false),
    remove: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    hasOAuth: vi.fn(() => false),
    hasOAuthSync: vi.fn(() => false),
  } as unknown as FullAuthPick
}

function makeService(opts: StoreOpts = {}): { svc: ConfigService; store: ReturnType<typeof makeStore> } {
  const store = makeStore(opts)
  const svc = new ConfigService('/tmp/project', store, makeAuth(opts.authIds ?? []))
  return { svc, store }
}

// ══ TC1: toggleProviderEnabled(true) 加 <id>/* 到 enabledModels ════════════════════

describe('TC1: toggleProviderEnabled(true) 加 <id>/* 到 enabledModels', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('enabledModels 非空 → 加 <id>/*', () => {
    const { svc, store } = makeService({ enabledModels: ['anthropic/*'] })
    svc.toggleProviderEnabled('openai', true)
    expect(store.setEnabledModels).toHaveBeenCalledWith(['anthropic/*', 'openai/*'])
  })

  it('CL1: enabledModels 空（全可用）→ no-op（不加 pattern，避免禁用其他）', () => {
    const { svc, store } = makeService({ enabledModels: [] })
    const ret = svc.toggleProviderEnabled('openai', true)
    expect(store.setEnabledModels).not.toHaveBeenCalled()
    expect(ret).toEqual({})
  })

  it('CL1: enabledModels undefined（全可用）→ no-op', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    svc.toggleProviderEnabled('openai', true)
    // 幂等：pattern 已在白名单，不重复加
    expect(store.setEnabledModels).not.toHaveBeenCalled()
  })
})

// ══ TC2: toggleProviderEnabled(false) 移除 <id>/* 与 <id>/model pattern ═════════════

describe('TC2: toggleProviderEnabled(false) 移除 <id>/* 与 <id>/model pattern', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('移除 provider 级（<id>/*）+ model 级（<id>/<model>）所有 pattern', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai/gpt-4', 'anthropic/*'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.setEnabledModels).toHaveBeenCalledWith(['anthropic/*'])
  })

  it('startsWith 带斜杠防前缀碰撞：openai 不误删 openai-compatible/*', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai-compatible/*'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.setEnabledModels).toHaveBeenCalledWith(['openai-compatible/*'])
  })

  it('幂等：provider 不在白名单时 no-op', () => {
    const { svc, store } = makeService({ enabledModels: ['anthropic/*'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.setEnabledModels).not.toHaveBeenCalled()
    expect(store.clearEnabledModels).not.toHaveBeenCalled()
  })
})

// ══ TC3: 边界3 空数组守卫——重算空时 clearEnabledModels（非写空数组）══════════════════

describe('TC3: 边界3 空数组守卫——重算空时 clearEnabledModels（delete 字段，CL2）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('移除最后一个 pattern → clearEnabledModels 调用，setEnabledModels 不调用（非写空数组）', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.clearEnabledModels).toHaveBeenCalledTimes(1)
    expect(store.setEnabledModels).not.toHaveBeenCalled()
  })

  it('model 级 pattern 移除至空 → 同样 clearEnabledModels', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/gpt-4'] })
    svc.toggleProviderEnabled('openai', false)
    expect(store.clearEnabledModels).toHaveBeenCalledTimes(1)
    expect(store.setEnabledModels).not.toHaveBeenCalled()
  })
})

// ══ TC4: 边界2 defaultModel 守卫——禁用承载 default 的 provider 时重选 ════════════════

describe('TC4: 边界2 defaultModel 守卫——禁用承载 default 的 provider 时重选', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('defaultModel=openai/gpt-4，禁用 openai → 重选为 anthropic 的 model，返回 newDefault', () => {
    const { svc, store } = makeService({
      models: {
        openai: { models: [{ id: 'gpt-4' }] },
        anthropic: { models: [{ id: 'claude-3' }] },
      },
      enabledModels: ['openai/*', 'anthropic/*'],
      defaultModel: { provider: 'openai', modelId: 'gpt-4' },
    })
    const ret = svc.toggleProviderEnabled('openai', false)
    // 重选写入 anthropic/claude-3
    expect(store.setDefaultModel).toHaveBeenCalledWith('anthropic', 'claude-3')
    expect(ret.newDefault).toEqual({ provider: 'anthropic', modelId: 'claude-3' })
  })

  it('禁用的 provider 不承载 default → 不重选，返回空对象', () => {
    const { svc, store } = makeService({
      models: {
        openai: { models: [{ id: 'gpt-4' }] },
        anthropic: { models: [{ id: 'claude-3' }] },
      },
      enabledModels: ['openai/*', 'anthropic/*'],
      defaultModel: { provider: 'anthropic', modelId: 'claude-3' },
    })
    const ret = svc.toggleProviderEnabled('openai', false)
    expect(store.setDefaultModel).not.toHaveBeenCalled()
    expect(ret).toEqual({})
  })
})

// ══ TC6: setProvider 停用 provider 级 enabled 写入 ══════════════════════════════════

describe('TC6: setProvider 停用 provider 级 enabled 写入（C5）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('provider 级 enabled（data.enabled）不写入 models.json', () => {
    const { svc, store } = makeService({
      models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
    })
    svc.setProvider('openai', { enabled: false })
    const merged = store.upsertProvider.mock.calls[0][1] as Record<string, unknown>
    // provider 级 enabled 不写入（停用——改由 enabledModels 承载）
    expect('enabled' in merged).toBe(false)
  })

  it('model 级 enabled（data.models[].enabled）仍正常写', () => {
    const { svc, store } = makeService({
      models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
    })
    svc.setProvider('openai', { models: [{ id: 'gpt-4', enabled: false }] })
    const merged = store.upsertProvider.mock.calls[0][1] as { models: Array<{ id: string; enabled?: boolean }> }
    expect(merged.models[0].enabled).toBe(false)
  })
})

// ══ setProvider 边界1 守卫——新建 provider 加白名单 ══════════════════════════════════

describe('setProvider 边界1守卫：新建 provider 时 ensureProviderInWhitelist（TC5 setProvider 路径）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('新建 provider（existingConfig===undefined）→ ensureProviderInWhitelist 调用', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    svc.setProvider('my-custom', { name: 'My', models: [{ id: 'm1' }] })
    expect(store.ensureProviderInWhitelist).toHaveBeenCalledWith('my-custom')
  })

  it('已有 provider（existingConfig!==undefined）→ ensureProviderInWhitelist 不调用', () => {
    const { svc, store } = makeService({
      models: { openai: { name: 'OpenAI', models: [{ id: 'gpt-4' }] } },
      enabledModels: ['openai/*'],
    })
    svc.setProvider('openai', { name: 'OpenAI Renamed' })
    expect(store.ensureProviderInWhitelist).not.toHaveBeenCalled()
  })
})

// ══ TC7: 联动验证——toggle 后 listProviders 的 enabled 派生正确 ═══════════════════════

describe('TC7: 联动——toggle 后 listProviders 的 enabled 派生正确反映', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('toggle(openai,false) 后 listProviders：openai→false，anthropic→true', () => {
    const { svc } = makeService({
      models: {
        openai: { models: [{ id: 'gpt-4' }] },
        anthropic: { models: [{ id: 'claude-3' }] },
      },
      enabledModels: ['openai/*', 'anthropic/*'],
    })
    svc.toggleProviderEnabled('openai', false)
    const byId = Object.fromEntries(svc.listProviders().map(p => [p.id, p]))
    expect(byId['openai'].enabled).toBe(false)
    expect(byId['anthropic'].enabled).toBe(true)
  })

  it('toggle(openai,true) 加白名单后 listProviders：openai→true', () => {
    const { svc } = makeService({
      models: {
        openai: { models: [{ id: 'gpt-4' }] },
        anthropic: { models: [{ id: 'claude-3' }] },
      },
      enabledModels: ['anthropic/*'],
    })
    // toggle 前 openai 未在白名单 → enabled=false
    expect(Object.fromEntries(svc.listProviders().map(p => [p.id, p]))['openai'].enabled).toBe(false)
    svc.toggleProviderEnabled('openai', true)
    expect(Object.fromEntries(svc.listProviders().map(p => [p.id, p]))['openai'].enabled).toBe(true)
  })
})

// ══ 边界3 持久化（CL2）：真实 pi-settings-store 验证 delete 字段后 settings.json 无 key ════

describe('边界3 持久化（CL2）：clearEnabledModels 后 settings.json 物理无 enabledModels key', () => {
  let dir: string
  let agentDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'toggle-bd3-'))
    agentDir = join(dir, 'pi', 'agent')
    mkdirSync(agentDir, { recursive: true })
    process.env.XYZ_AGENT_DATA_DIR = dir
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()
  })

  afterEach(() => {
    delete process.env.XYZ_AGENT_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it("setEnabledModels(['openai/*']) 后 clearEnabledModels → settings.json 无 enabledModels key", () => {
    // 先写一个非空白名单
    setEnabledModels(['openai/*'])
    let raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['openai/*'])

    // clearEnabledModels 用 updateSettingsSync(delete) 删字段
    clearEnabledModels()
    // 文件仍存在（只删 key，非删文件）
    expect(existsSync(join(agentDir, 'settings.json'))).toBe(true)
    // JSON.stringify 丢弃 undefined 字段 → settings.json 物理无 enabledModels key
    raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect('enabledModels' in raw).toBe(false)
  })

  it("ensureProviderInWhitelist：enabledModels 非空时加 <id>/*，空时 no-op（真实行为）", () => {
    // 空（全可用）→ no-op，settings.json 不出现 enabledModels
    ensureProviderInWhitelist('openai')
    expect(existsSync(join(agentDir, 'settings.json'))).toBe(false)

    // 非空 → 加 pattern
    setEnabledModels(['anthropic/*'])
    ensureProviderInWhitelist('openai')
    const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['anthropic/*', 'openai/*'])

    // 幂等：重复加同 id 不重复
    ensureProviderInWhitelist('openai')
    const raw2 = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw2.enabledModels).toEqual(['anthropic/*', 'openai/*'])
  })
})
