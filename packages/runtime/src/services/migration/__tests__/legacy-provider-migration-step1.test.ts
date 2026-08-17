/**
 * step1 catalog apiKey 迁移测试（M5-04 修复验证 + 既有行为回归）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/beforeEach/afterEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/migration/__tests__/legacy-provider-migration-step1.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + XYZ_AGENT_DATA_DIR env），
 * 与 legacy-provider-migration-step2.test.ts 同模式。isCatalogProvider 走真实实现
 *（builtin-providers.json 判定，openai/anthropic 均为 catalog provider）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyProviderConfig } from '../legacy-provider-migration.js'
import { setModelsPath } from '../../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { AuthStorage } from '../../auth/auth-storage.js'

let dir: string
let agentDir: string

function writeModels(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

function readModelsRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8'))
}

function readAuthRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf-8'))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legacy-migration-step1-'))
  agentDir = join(dir, 'pi', 'agent')
  mkdirSync(agentDir, { recursive: true })
  process.env.XYZ_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({}, null, 2))
})

afterEach(() => {
  delete process.env.XYZ_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('M5-04: step1 hasOverride 判定含 models/quota（catalog 条目保留仅删 apiKey）', () => {
  it('catalog 条目含 models 无 baseUrl → 保留条目，仅删 apiKey，model 级 enabled 保留', async () => {
    writeModels({
      openai: { apiKey: 'sk-test', models: [{ id: 'gpt-4', enabled: false }] },
    })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))

    const report = await migrateLegacyProviderConfig(new PiConfigStore(), authStorage)

    expect(report.migrated).toContain('openai')
    // models.json：条目保留（hasOverride——models 属用户配置，删除即丢 model 级 enabled），
    // apiKey 删除，models 原样（model.enabled=false 保留，与 step2「model 级 enabled 保留」承诺一致）
    const openai = (readModelsRaw().providers as Record<string, Record<string, unknown>>).openai
    expect(openai).toBeDefined()
    expect(openai.apiKey).toBeUndefined()
    const models = openai.models as Array<Record<string, unknown>>
    expect(models[0].enabled).toBe(false)
    // auth.json：apiKey 已迁入
    expect(readAuthRaw().openai).toEqual({ type: 'api_key', key: 'sk-test' })
  })

  it('catalog 条目含 quota 无 baseUrl → 保留条目，仅删 apiKey，quota 保留', async () => {
    writeModels({
      anthropic: { apiKey: 'sk-test', quota: { fetcher: 'custom', enabled: true } },
    })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))

    const report = await migrateLegacyProviderConfig(new PiConfigStore(), authStorage)

    expect(report.migrated).toContain('anthropic')
    const anthropic = (readModelsRaw().providers as Record<string, Record<string, unknown>>).anthropic
    expect(anthropic).toBeDefined()
    expect(anthropic.apiKey).toBeUndefined()
    expect(anthropic.quota).toEqual({ fetcher: 'custom', enabled: true })
  })

  it('回归：无 override（仅 apiKey）→ 整条删除（catalog 回退 builtin template）', async () => {
    writeModels({ openai: { apiKey: 'sk-test' } })
    const authStorage = new AuthStorage(join(agentDir, 'auth.json'))

    const report = await migrateLegacyProviderConfig(new PiConfigStore(), authStorage)

    expect(report.migrated).toContain('openai')
    // A7：removeProvider 删整个条目，catalog provider 回退 builtin template
    expect((readModelsRaw().providers as Record<string, unknown>).openai).toBeUndefined()
    // auth.json：apiKey 已迁入（迁移不因删条目而丢失凭据）
    expect(readAuthRaw().openai).toEqual({ type: 'api_key', key: 'sk-test' })
  })
})
