/**
 * removeProviderByKind 测试（wave4，provider-dual-system-r2::provider-ui-by-kind IF3）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/config-service-removebykind.test.ts
 *
 * 覆盖 design TC2/TC3 + 边界3(a)：
 *   - TC2 catalog 分支：清 auth.json 凭据 + 清 models.json override（removeProvider）+ 清 enabledModels 残留。
 *     不删 pi catalog 定义（本测试只验证 xyz-agent 侧清理动作，pi 定义不可触达故不断言）。
 *   - TC3 custom 分支：删 models.json 条目（removeProvider）+ 清残留。
 *   - 边界3(a) 残留清除空数组守卫：清完残留后白名单空 → cleanEnabledModelsResidue 调 clearEnabledModels（非 setEnabledModels([])）。
 *
 * 策略：mock IConfigStore（写方法 vi.fn 断言路由）+ mock authStorage.remove 断言清凭据调用。
 * makeStore 借鉴 config-service-toggle.test.ts 的状态化 mock 模式，但本测试聚焦「调用路由」
 * 而非 read-after-write，故 store 用最小 mock（getEnabledModels 返固定白名单即可）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConfigService } from '../config-service.js'
import type { IConfigStore, ConfigModelsConfig } from '../ports/config.js'
import type { AuthStorage } from '../auth/auth-storage.js'

type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

interface StoreOpts {
  /** models.json providers（默认空）。 */
  models?: ConfigModelsConfig['providers']
  /** settings.json.enabledModels（默认空 = 全启用）。 */
  enabledModels?: string[]
}

/**
 * 最小 mock IConfigStore：写方法 vi.fn 供断言路由，读方法返固定值。
 * removeProvider 返回 removed:true（catalog override 存在时；custom 删除时）。
 */
function makeStore(opts: StoreOpts = {}) {
  const models: ConfigModelsConfig['providers'] = opts.models ? JSON.parse(JSON.stringify(opts.models)) : {}
  return {
    readModels: vi.fn(() => ({ providers: models })),
    getEnabledModels: vi.fn(() => [...(opts.enabledModels ?? [])]),
    getDefaultModel: vi.fn(() => null),
    getProviderConfig: vi.fn((id: string) => (id in models ? JSON.parse(JSON.stringify(models[id])) : undefined)),
    setEnabledModels: vi.fn(),
    clearEnabledModels: vi.fn(),
    setDefaultModel: vi.fn(),
    ensureProviderInWhitelist: vi.fn(),
    cleanEnabledModelsResidue: vi.fn(),
    upsertProvider: vi.fn(),
    applyTypeTranslation: vi.fn((t: string) => t),
    removeProvider: vi.fn(() => ({ removed: true })),
  } as unknown as IConfigStore & {
    setEnabledModels: ReturnType<typeof vi.fn>
    clearEnabledModels: ReturnType<typeof vi.fn>
    cleanEnabledModelsResidue: ReturnType<typeof vi.fn>
    removeProvider: ReturnType<typeof vi.fn>
  }
}

function makeAuth(): FullAuthPick {
  return {
    listCredentialIds: vi.fn(() => []),
    hasCredentialSync: vi.fn(() => false),
    remove: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    hasOAuth: vi.fn(() => false),
    hasOAuthSync: vi.fn(() => false),
  } as unknown as FullAuthPick
}

function makeService(opts: StoreOpts = {}): { svc: ConfigService; store: ReturnType<typeof makeStore>; auth: FullAuthPick } {
  const store = makeStore(opts)
  const auth = makeAuth()
  const svc = new ConfigService('/tmp/project', store, auth)
  return { svc, store, auth }
}

// ══ TC2: catalog 分支——清 auth.json 凭据 + 清 override + 清残留 ═══════════════════════

describe('TC2: removeProviderByKind(catalog) 清 auth.json 凭据 + override + enabledModels 残留', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('调 authStorage.remove（清 catalog 凭据）', () => {
    const { svc, auth } = makeService({ enabledModels: ['openai/*'] })
    svc.removeProviderByKind('openai', 'catalog')
    expect(auth.remove).toHaveBeenCalledWith('openai')
  })

  it('调 configStore.removeProvider（清 models.json override 条目，若有）', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    svc.removeProviderByKind('openai', 'catalog')
    expect(store.removeProvider).toHaveBeenCalledWith('openai')
  })

  it('调 configStore.cleanEnabledModelsResidue（清 enabledModels 残留 <id>/* 与 <id>/model）', () => {
    const { svc, store } = makeService({ enabledModels: ['openai/*', 'openai/gpt-4', 'anthropic/*'] })
    svc.removeProviderByKind('openai', 'catalog')
    expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
  })

  it('返回 removed:true（catalog 定义不可删，用户侧状态已清即视为移除成功）', () => {
    const { svc } = makeService({ enabledModels: ['openai/*'] })
    const ret = svc.removeProviderByKind('openai', 'catalog')
    expect(ret).toEqual({ removed: true })
  })

  it('MF1（exec-review must-fix）：catalog override 承载 default 时透传 removeProvider 的 newDefault', () => {
    // 场景：catalog provider openai 有 override 且承载 defaultModel，removeProvider 删 override 时
    // 内部重选 default（anthropic/claude-3）+ mutate settings.json。catalog 分支须透传 newDefault，
    // 否则 handler 不广播 config.defaults → renderer 收不到重选通知（confirmDelete 防御性清空仅缓解显示）。
    const { svc, store } = makeService({ enabledModels: ['openai/*'] })
    ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      removed: true,
      newDefault: { provider: 'anthropic', modelId: 'claude-3' },
    })
    const ret = svc.removeProviderByKind('openai', 'catalog')
    expect(ret).toEqual({ removed: true, newDefault: { provider: 'anthropic', modelId: 'claude-3' } })
  })

  it('authStorage.remove 失败（reject）不阻塞移除主流程（fire-and-forget warn）', async () => {
    const { svc, store, auth } = makeService({ enabledModels: ['openai/*'] })
    ;(auth.remove as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'))
    // 同步调用不抛（remove 是 fire-and-forget void Promise）
    const ret = svc.removeProviderByKind('openai', 'catalog')
    expect(ret).toEqual({ removed: true })
    expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
    // 等微任务跑完 reject（避免 unhandledRejection 警告）
    await new Promise(r => setTimeout(r, 0))
  })
})

// ══ TC3: custom 分支——删 models.json 条目 + 清残留 ═══════════════════════════════════

describe('TC3: removeProviderByKind(custom) 删 models.json 条目 + 清 enabledModels 残留', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('调 configStore.removeProvider（删 custom 定义条目）', () => {
    const { svc, store } = makeService({ enabledModels: ['my-custom/*'] })
    svc.removeProviderByKind('my-custom', 'custom')
    expect(store.removeProvider).toHaveBeenCalledWith('my-custom')
  })

  it('调 configStore.cleanEnabledModelsResidue（清残留）', () => {
    const { svc, store } = makeService({ enabledModels: ['my-custom/*', 'openai/*'] })
    svc.removeProviderByKind('my-custom', 'custom')
    expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('my-custom')
  })

  it('不调 authStorage.remove（custom 凭据在 models.json，删条目即清，不走 auth.json）', () => {
    const { svc, auth } = makeService({ enabledModels: ['my-custom/*'] })
    svc.removeProviderByKind('my-custom', 'custom')
    expect(auth.remove).not.toHaveBeenCalled()
  })

  it('透传 removeProvider 返回值（含 default 重选 newDefault）', () => {
    const { svc, store } = makeService({ enabledModels: ['my-custom/*'] })
    ;(store.removeProvider as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      removed: true,
      newDefault: { provider: 'openai', modelId: 'gpt-4' },
    })
    const ret = svc.removeProviderByKind('my-custom', 'custom')
    expect(ret).toEqual({ removed: true, newDefault: { provider: 'openai', modelId: 'gpt-4' } })
  })
})

// ══ 边界3(a): cleanEnabledModelsResidue 空数组守卫（pi-provider-store 层） ════════════
// 注：removeProviderByKind 调 configStore.cleanEnabledModelsResidue（port），实际守卫逻辑
// 在 pi-provider-store.cleanEnabledModelsResidue。此用例直接测 pi-provider-store 导出函数，
// 验证「重算空 → clearEnabledModels（delete 字段，非 setEnabledModels([])）」的边界3(a) 守卫。

import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('边界3(a): cleanEnabledModelsResidue 重算空 → clearEnabledModels（delete 字段，CL2）', () => {
  let dir: string
  let agentDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'clean-residue-'))
    agentDir = join(dir, 'pi', 'agent')
    mkdirSync(agentDir, { recursive: true })
    process.env.XYZ_AGENT_DATA_DIR = dir
  })

  afterEach(() => {
    delete process.env.XYZ_AGENT_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('多 pattern 移除后非空 → setEnabledModels(remaining)；再清至空 → delete enabledModels 字段', async () => {
    // 动态 import：测试体内拿函数引用，确保 setModelsPath/setSettingsPath 已指向临时目录后再调用
    const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
    const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()

    // 先写非空白名单（含 openai 多个 pattern + anthropic）
    setEnabledModels(['openai/*', 'openai/gpt-4', 'anthropic/*'])

    // 清 openai 残留 → 剩 anthropic/*（非空）→ setEnabledModels(['anthropic/*'])
    cleanEnabledModelsResidue('openai')
    let raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['anthropic/*'])

    // 再清 anthropic 残留 → 剩空 → clearEnabledModels（delete 字段，CL2——非写空数组）
    cleanEnabledModelsResidue('anthropic')
    raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect('enabledModels' in raw).toBe(false)
  })

  it('startsWith 带斜杠防前缀碰撞：清 openai 不误删 openai-compatible/*', async () => {
    const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
    const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()

    setEnabledModels(['openai/*', 'openai-compatible/*'])
    cleanEnabledModelsResidue('openai')
    const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['openai-compatible/*'])
  })

  it('幂等：provider 不在白名单时 no-op（文件不重复写）', async () => {
    const { cleanEnabledModelsResidue, setEnabledModels, setModelsPath } = await import('../../infra/pi/pi-provider-store.js')
    const { setSettingsPath, invalidateSettingsCache } = await import('../../infra/pi/pi-settings-store.js')
    setModelsPath(join(agentDir, 'models.json'))
    setSettingsPath(join(agentDir, 'settings.json'))
    invalidateSettingsCache()

    setEnabledModels(['anthropic/*'])
    cleanEnabledModelsResidue('openai') // openai 本不在白名单
    const raw = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(raw.enabledModels).toEqual(['anthropic/*']) // 无变化
  })
})
