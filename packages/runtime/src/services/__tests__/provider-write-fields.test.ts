/**
 * B-4a/B-4b setProvider 写入字段测试（provider-config-quota-architecture design §5 Phase B-4）。
 *
 * B-4a：headers/authHeader（pi ProviderConfigSchema 内字段）写入 models.json provider 条目
 * ——修复 design §2.1 场景 D 的写入断链（前端已发送、runtime 不写）。
 * B-4b：模型写入白名单补 reasoning/maxTokens/cost/headers（pi ModelDefinitionSchema 内字段），
 * 非法值 throw 不静默丢弃。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-write-fields.test.ts
 *
 * 策略：真实文件系统（临时目录 + setModelsPath/setSettingsPath + XYZ_AGENT_DATA_DIR env），
 * 与 provider-read-source-switch.test.ts 同模式——落盘断言读回真实 models.json（而非 mock
 * upsertProvider 入参），「不落盘」断言比较校验失败后文件内容与写入前逐字一致。
 * 用 custom provider（my-proxy）隔离 catalog apiKey 剥离分支的干扰。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { setModelsPath } from '../../infra/pi/pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../../infra/pi/pi-settings-store.js'
import { PiConfigStore } from '../../infra/pi/pi-config-store.js'

let dir: string
let agentDir: string
let configStore: PiConfigStore
let svc: ConfigService

function writeModelsJson(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

function readModelsJson(): Record<string, any> {
  return JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8'))
}

function modelsJsonRaw(): string {
  return readFileSync(join(agentDir, 'models.json'), 'utf-8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-write-fields-'))
  agentDir = join(dir, 'pi', 'agent')
  mkdirSync(join(agentDir, 'config'), { recursive: true })
  process.env.XYZ_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  configStore = new PiConfigStore()
  svc = new ConfigService('/tmp/project', configStore)
})

afterEach(() => {
  delete process.env.XYZ_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('B-4a：headers/authHeader 写入 models.json provider 条目（断链修复）', () => {
  it('传 headers + authHeader → 落盘且值正确', async () => {
    await svc.setProvider('my-proxy', {
      name: 'My Proxy',
      baseUrl: 'https://proxy.example.com',
      headers: { 'X-Custom': 'abc', Authorization: 'Bearer tok' },
      authHeader: true,
    })
    const entry = readModelsJson().providers['my-proxy']
    expect(entry.headers).toEqual({ 'X-Custom': 'abc', Authorization: 'Bearer tok' })
    expect(entry.authHeader).toBe(true)
  })

  it('不传（undefined）→ 既有值保留（不覆盖）', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      headers: { 'X-Keep': 'me' },
      authHeader: true,
    })
    // 后续保存不带 headers/authHeader（前端编辑其它字段时的形态）
    await svc.setProvider('my-proxy', { name: 'Renamed' })
    const entry = readModelsJson().providers['my-proxy']
    expect(entry.headers).toEqual({ 'X-Keep': 'me' })
    expect(entry.authHeader).toBe(true)
    expect(entry.name).toBe('Renamed')
  })

  it('headers 传空对象 {} → 清空（undefined=不变 / {}=清空的两态语义）', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      headers: { 'X-Old': 'v1' },
      authHeader: true,
    })
    await svc.setProvider('my-proxy', { headers: {} })
    const entry = readModelsJson().providers['my-proxy']
    expect(entry.headers).toEqual({})
  })

  it('authHeader 显式 false → 覆盖既有 true（boolean 不能用 truthiness 判定）', async () => {
    await svc.setProvider('my-proxy', { baseUrl: 'https://proxy.example.com', authHeader: true })
    await svc.setProvider('my-proxy', { authHeader: false })
    expect(readModelsJson().providers['my-proxy'].authHeader).toBe(false)
  })

  it('headers 非法（数组 / value 非 string）→ reject 且 models.json 不被写坏', async () => {
    writeModelsJson({ 'my-proxy': { baseUrl: 'https://proxy.example.com' } })
    const before = modelsJsonRaw()

    await expect(svc.setProvider('my-proxy', { headers: ['X-Bad'] as unknown as Record<string, string> }))
      .rejects.toThrow(/Invalid headers for provider "my-proxy"/)
    await expect(svc.setProvider('my-proxy', { headers: { 'X-Num': 123 as unknown as string } }))
      .rejects.toThrow(/value of "X-Num" must be a string/)

    expect(modelsJsonRaw()).toBe(before)
  })

  it('authHeader 非法（非 boolean）→ reject 且不落盘', async () => {
    writeModelsJson({ 'my-proxy': { baseUrl: 'https://proxy.example.com' } })
    const before = modelsJsonRaw()

    await expect(svc.setProvider('my-proxy', { authHeader: 'yes' as unknown as boolean }))
      .rejects.toThrow(/authHeader for provider "my-proxy": must be a boolean/)

    expect(modelsJsonRaw()).toBe(before)
  })

  it('headers 含 __proto__/constructor key → 清洗后落盘（prototype-pollution 防护）', async () => {
    const malicious: Record<string, string> = JSON.parse('{"__proto__":{"polluted":"x"},"constructor":{"y":"z"},"X-Safe":"ok"}')
    await svc.setProvider('my-proxy', { baseUrl: 'https://proxy.example.com', headers: malicious })

    const entry = readModelsJson().providers['my-proxy']
    expect(entry.headers).toEqual({ 'X-Safe': 'ok' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('B-4b：模型写入白名单 reasoning/maxTokens/cost/headers', () => {
  it('四字段落盘且值正确（cost 含 tiers 可选透传）', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      models: [{
        id: 'my-model',
        name: 'My Model',
        reasoning: true,
        maxTokens: 8192,
        cost: { input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 },
        headers: { 'X-Model-Header': 'v' },
      }],
    })
    const model = readModelsJson().providers['my-proxy'].models[0]
    expect(model.reasoning).toBe(true)
    expect(model.maxTokens).toBe(8192)
    expect(model.cost).toEqual({ input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75 })
    expect(model.headers).toEqual({ 'X-Model-Header': 'v' })
  })

  it('cost tiers 存在时透传', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      models: [{
        id: 'my-model',
        cost: {
          input: 3, output: 15, cacheRead: 0.6, cacheWrite: 3.75,
          tiers: [{ inputTokensAbove: 200000, input: 6, output: 30, cacheRead: 1.2, cacheWrite: 7.5 }],
        },
      }],
    })
    const model = readModelsJson().providers['my-proxy'].models[0]
    expect(model.cost.tiers).toEqual([{ inputTokensAbove: 200000, input: 6, output: 30, cacheRead: 1.2, cacheWrite: 7.5 }])
  })

  it('未传的字段沿用盘上既有值（base spread 兜底，undefined=不变）', async () => {
    await svc.setProvider('my-proxy', {
      baseUrl: 'https://proxy.example.com',
      models: [{ id: 'my-model', maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } }],
    })
    // 编辑保存：回传同 id 只改 name（前端编辑名称场景），其余字段不回传
    await svc.setProvider('my-proxy', {
      models: [{ id: 'my-model', name: 'Renamed Model' }],
    })
    const model = readModelsJson().providers['my-proxy'].models[0]
    expect(model.name).toBe('Renamed Model')
    expect(model.maxTokens).toBe(4096)
    expect(model.cost).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 })
  })

  it('非法值 → reject 且 models.json 不被写坏（不静默丢弃）', async () => {
    writeModelsJson({ 'my-proxy': { baseUrl: 'https://proxy.example.com' } })
    const before = modelsJsonRaw()

    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', maxTokens: -1 }],
    })).rejects.toThrow(/Invalid maxTokens for model "m1"/)
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', maxTokens: 1.5 }],
    })).rejects.toThrow(/Invalid maxTokens for model "m1"/)
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', reasoning: 'yes' as unknown as boolean }],
    })).rejects.toThrow(/Invalid reasoning for model "m1"/)
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', cost: { input: 'x' } as unknown as { input: number } }],
    })).rejects.toThrow(/Invalid cost for model "m1"/)
    await expect(svc.setProvider('my-proxy', {
      // pi ModelCostSchema 四字段必填：缺字段写入会让 pi 拒载整个 models.json
      models: [{ id: 'm1', cost: { input: 1 } }],
    })).rejects.toThrow(/Invalid cost for model "m1".*"output"/)
    await expect(svc.setProvider('my-proxy', {
      models: [{ id: 'm1', headers: ['bad'] as unknown as Record<string, string> }],
    })).rejects.toThrow(/Invalid headers for model "m1"/)

    expect(modelsJsonRaw()).toBe(before)
  })
})
