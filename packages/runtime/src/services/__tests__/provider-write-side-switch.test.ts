/**
 * A1-5 写侧切换测试：quota.configure 与 setProvider 改写 config/providers.json，
 * models.json 不再落寄生字段（验收 3）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-write-side-switch.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + XYZ_AGENT_DATA_DIR env），
 * 与 legacy-provider-migration-step2.test.ts 同模式。物理读两个文件断言终态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaService } from '../quota-service.js'
import { ConfigService } from '../config-service.js'
import { XyzProviderStore } from '../provider-extras-store.js'
import type { SetProviderInput } from '../provider-config-helper.js'
import { setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../infra/pi/pi-config-store.js'

let dir: string
let agentDir: string
let extrasPath: string
let extrasStore: XyzProviderStore
let configStore: PiConfigStore

function writeModelsJson(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

function readModelsRaw(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8')).providers
}

function readExtrasRaw(): Record<string, unknown> {
  // 文件不存在 = 空扩展数据（XyzProviderStore 读路径不物化文件）
  if (!existsSync(extrasPath)) return {}
  return JSON.parse(readFileSync(extrasPath, 'utf-8')).providers
}

function makeQuotaService(providerExists: (id: string) => boolean): QuotaService {
  return new QuotaService({ dataDir: dir, providerExtrasStore: extrasStore, providerExists })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-write-side-switch-'))
  agentDir = join(dir, 'pi', 'agent')
  mkdirSync(join(agentDir, 'config'), { recursive: true })
  process.env.XYZ_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  extrasPath = join(agentDir, 'config', 'providers.json')
  extrasStore = new XyzProviderStore(extrasPath)
  configStore = new PiConfigStore()
})

afterEach(() => {
  delete process.env.XYZ_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('QuotaService.configure 写侧切换（A1-5 路径 1）', () => {
  it('configure 成功：providers.json 更新 quota（enabled/fetcher），models.json 无 quota 字段', async () => {
    writeModelsJson({
      'zai-coding-cn': { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKey: 'sk-x' },
    })
    const svc = makeQuotaService(() => true)

    const result = await svc.configure('zai-coding-cn', true, undefined, 'zhipu')

    expect(result).toEqual({ ok: true })
    expect(readExtrasRaw()['zai-coding-cn']).toEqual({
      quota: { fetcher: 'zhipu', enabled: true },
    })
    // models.json 不落 quota（寄生字段禁复活）
    expect(readModelsRaw()['zai-coding-cn']?.quota).toBeUndefined()
    expect(existsSync(extrasPath)).toBe(true)
  })

  it('场景 E：models.json 无条目但聚合层存在（oauth-only catalog provider）→ configure 成功', async () => {
    writeModelsJson({}) // models.json 完全无该 provider
    const svc = makeQuotaService(id => id === 'kimi-coding')

    const result = await svc.configure('kimi-coding', true)

    expect(result).toEqual({ ok: true })
    expect(readExtrasRaw()['kimi-coding']).toEqual({ quota: { enabled: true } })
  })

  it('聚合层不存在的 provider → 拒绝（ok:false，不落盘）', async () => {
    const svc = makeQuotaService(() => false)
    const result = await svc.configure('nonexistent', true)
    expect(result.ok).toBe(false)
    expect(existsSync(extrasPath)).toBe(false)
  })

  it('fetcher 未传时继承既有值：providers.json 已有 fetcher 优先', async () => {
    writeModelsJson({
      p1: { baseUrl: 'https://x.example.com', quota: { fetcher: 'legacy-kimi', enabled: false } },
    })
    await extrasStore.modify('p1', () => ({ quota: { fetcher: 'zhipu', enabled: false } }))
    const svc = makeQuotaService(() => true)

    await svc.configure('p1', true) // fetcher 未传

    // providers.json 的 zhipu 优先，models.json 旧值 legacy-kimi 不复活
    expect(readExtrasRaw()['p1']).toEqual({ quota: { fetcher: 'zhipu', enabled: true } })
  })

  it('fetcher 未传时继承既有值：providers.json 无条目回退 models.json 旧 quota（迁移失败窗口）', async () => {
    writeModelsJson({
      p1: {
        baseUrl: 'https://x.example.com',
        quota: { fetcher: 'legacy-kimi', enabled: false, cookieSet: true },
      },
    })
    const svc = makeQuotaService(() => true)

    await svc.configure('p1', true) // fetcher 未传

    expect(readExtrasRaw()['p1']).toEqual({
      quota: { fetcher: 'legacy-kimi', enabled: true, cookieSet: true },
    })
  })

  it('未注入 providerExtrasStore → 持久化失败返回（宁失败不写错位）', async () => {
    writeModelsJson({ p1: { baseUrl: 'https://x.example.com' } })
    const svc = new QuotaService({ dataDir: dir, providerExists: () => true })

    const result = await svc.configure('p1', true)

    expect(result.ok).toBe(false)
    expect(existsSync(extrasPath)).toBe(false)
  })
})

describe('setProvider 写侧切换（A1-5 路径 2/3）', () => {
  function makeSvc(): ConfigService {
    return new ConfigService('/tmp/project', configStore, undefined, extrasStore)
  }

  it('authMethod 写 providers.json，models.json 不落 authMethod（路径 2）', async () => {
    writeModelsJson({})
    const svc = makeSvc()

    await svc.setProvider('my-custom', {
      apiKey: 'sk-x',
      authMethod: 'api_key',
      baseUrl: 'https://x.example.com',
      models: [{ id: 'm1', name: 'M1' }],
    })

    const providers = readModelsRaw()
    expect(providers['my-custom']?.authMethod).toBeUndefined()
    // 其余写入（apiKey/baseUrl/models）不变——models.json 保留 pi 原生语义字段
    expect(providers['my-custom']).toEqual({
      apiKey: 'sk-x',
      baseUrl: 'https://x.example.com',
      models: [{ id: 'm1', name: 'M1' }],
    })
    expect(readExtrasRaw()['my-custom']).toEqual({ authMethod: 'api_key' })
  })

  it('二次保存更新 authMethod：providers.json 覆写、models.json 始终干净', async () => {
    writeModelsJson({})
    const svc = makeSvc()

    await svc.setProvider('my-custom', { apiKey: 'sk-x', authMethod: 'api_key', baseUrl: 'https://x.example.com' })
    await svc.setProvider('my-custom', { authMethod: 'oauth' })

    expect(readExtrasRaw()['my-custom']).toEqual({ authMethod: 'oauth' })
    expect(readModelsRaw()['my-custom']?.authMethod).toBeUndefined()
  })

  it('setProvider 不传 authMethod → providers.json 既有 authMethod 保留（modify 只覆写该字段）', async () => {
    writeModelsJson({ p1: { baseUrl: 'https://x.example.com' } })
    await extrasStore.modify('p1', () => ({ authMethod: 'api_key' }))
    const svc = makeSvc()

    await svc.setProvider('p1', { name: 'Renamed' })

    expect(readExtrasRaw()['p1']).toEqual({ authMethod: 'api_key' })
  })

  it('防复活（路径 3）：调用方恶意传 quota → models.json 与 providers.json 均不落 quota', async () => {
    writeModelsJson({})
    const svc = makeSvc()

    // quota 字段已从 SetProviderInput 类型删除——cast 模拟绕过类型的恶意调用方
    const malicious = {
      apiKey: 'sk-x',
      baseUrl: 'https://x.example.com',
      quota: { fetcher: 'zhipu', enabled: true },
    } as unknown as SetProviderInput
    await svc.setProvider('evil', malicious)

    expect(readModelsRaw()['evil']?.quota).toBeUndefined()
    expect(readExtrasRaw()['evil']).toBeUndefined()
  })

  it('未注入 extrasStore 时 authMethod 丢弃 + 不抛错（宁丢不写错位）', async () => {
    writeModelsJson({})
    const svc = new ConfigService('/tmp/project', configStore, undefined, undefined)

    await svc.setProvider('my-custom', {
      apiKey: 'sk-x',
      authMethod: 'api_key',
      baseUrl: 'https://x.example.com',
    })

    expect(readModelsRaw()['my-custom']?.authMethod).toBeUndefined()
    expect(existsSync(extrasPath)).toBe(false)
  })
})
