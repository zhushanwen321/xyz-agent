/**
 * findValidDefaultModel catalog 兜底测试（2026-08-09 回归修复）。
 *
 * 回归背景：兜底逻辑曾直接取 builtinData.providers[0]（字母序第一个 =
 * amazon-bedrock，ambient 认证无凭据）作为默认模型，且 wasFixed=true 把
 * 兜底结果写回 settings.json 污染用户配置。修复：遍历 catalog 找凭据
 * 可解析的 provider（auth.json credential / models.json apiKey），
 * wasFixed=false 不写回。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findValidDefaultModel, setModelsPath, sanitizeInvalidProviders } from '../pi-provider-store.js'
import { setSettingsPath, invalidateSettingsCache } from '../pi-settings-store.js'

let dir: string
let agentDir: string

/** 真实结构：<dataDir>/pi/agent/（getPiAgentDir = getConfigDir()/pi/agent） */
function realAgentDir(): string {
  return join(dir, 'pi', 'agent')
}

function writeModels(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

function writeSettings(defaultProvider?: string, defaultModel?: string): void {
  const s: Record<string, unknown> = {}
  if (defaultProvider) s.defaultProvider = defaultProvider
  if (defaultModel) s.defaultModel = defaultModel
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(s, null, 2))
}

function writeAuth(credentials: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify(credentials, null, 2))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-store-'))
  agentDir = realAgentDir()
  mkdirSync(agentDir, { recursive: true })
  // readAuthCredentials 经 getPiAgentDir() 实时读 env；models/settings 经 setPath 注入
  process.env.XYZ_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  // 清空 auth.json（readAuthCredentials 直接读 agentDir/auth.json）
  writeAuth({})
})

afterEach(() => {
  delete process.env.XYZ_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('findValidDefaultModel catalog 兜底（凭据校验）', () => {
  it('回归：无凭据时返回 null，不选 ambient 的 amazon-bedrock（曾被写进 settings.json 污染）', () => {
    writeModels({})
    writeSettings('amazon-bedrock', 'amazon.nova-2-lite-v1:0')  // 被污染的 default（无凭据）
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
    expect(r.wasFixed).toBe(false)
  })

  it('修复：auth.json 有 api_key 凭据的 catalog provider 被选中（zai-coding-cn）', () => {
    writeModels({ zai: { name: 'zai', apiKey: undefined, models: [] } })
    writeAuth({ 'zai-coding-cn': { type: 'api_key', key: 'k1' } })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('zai-coding-cn')
    expect(r.result!.modelId).toBeTruthy()
    expect(r.wasFixed).toBe(false)  // 兜底不写回 settings.json
  })

  it('修复：models.json 有 apiKey 的 catalog provider 被选中（凭据校验含 models.json apiKey）', () => {
    writeModels({ anthropic: { name: 'Anthropic', apiKey: 'sk-x', models: [] } })
    const r = findValidDefaultModel()
    expect(r.result).not.toBeNull()
    expect(r.result!.provider).toBe('anthropic')
    expect(r.wasFixed).toBe(false)
  })

  it('修复：无凭据的 catalog provider 全部跳过 → 返回 null（amazon-bedrock 不可选）', () => {
    writeModels({})
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })

  it('既有行为：models.json 有 models 数组的 provider 优先（不触发 catalog 兜底）', () => {
    writeModels({ 'my-router': { name: 'router', apiKey: 'k', models: [{ id: 'm1' }] } })
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'my-router', modelId: 'm1' })
    expect(r.wasFixed).toBe(true)  // 数据修复语义保留
  })

  it('既有行为：settings 显式 default 有效时直接返回（wasFixed=false）', () => {
    writeModels({ openai: { name: 'OpenAI', apiKey: 'k', models: [{ id: 'gpt-4' }] } })
    writeSettings('openai', 'gpt-4')
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'openai', modelId: 'gpt-4' })
    expect(r.wasFixed).toBe(false)
  })

  it('auth.json 损坏 → 不抛错，按无凭据处理（兜底 best-effort）', () => {
    writeModels({})
    writeFileSync(join(agentDir, 'auth.json'), '{ not valid json')
    const r = findValidDefaultModel()
    expect(r.result).toBeNull()
  })
})

// ══ D2 存量清洗（catalog-provider-field-authority v3.3 §3.3 D2）══════════════
//
// 清洗顺序契约：① 空串键剥除 → ② catalog 条目的 provider 级键处置（api 一律剥 /
// baseUrl 按 extras gatewayBaseUrl 标记，仅存在性判定）→ 既有空壳判定/修复（MF-5 语义不变）。
// 标记读取经注入的 getExtrasSync（infra 层不 import services 实现，C-comm-03）。

/** 读盘上的 providers 对象（断言真实落盘内容，而非内存模型）。 */
function readProvidersFromDisk(): Record<string, Record<string, unknown>> {
  return (JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf-8')) as {
    providers: Record<string, Record<string, unknown>>
  }).providers
}

/** 注入标记读取原语（仅存在性语义）。 */
function markerReader(marked: string[]) {
  return { getExtrasSync: (id: string) => (marked.includes(id) ? { gatewayBaseUrl: 'https://gw.example' } : undefined) }
}

describe('sanitizeInvalidProviders — D2 空串剥键 + catalog provider 级键处置', () => {
  it('D2①: pi minLength:1 空串全集剥键矩阵（provider 4 字段 + 模型级 name/api/baseUrl + modelOverrides name）', () => {
    writeModels({
      // 非 catalog id（避开 ② 的 provider 级键处置），headers 保证剥完后仍是合法条目
      'my-custom-llm': {
        name: '',
        baseUrl: '   ',
        apiKey: '',
        api: '',
        headers: { 'X-Test': '1' },
        models: [
          { id: 'm1', name: '', api: '  ', baseUrl: '' },
          { id: 'm2', name: 'M2' },
        ],
        modelOverrides: { 'gpt-4': { name: '' } },
      },
    })

    const outcome = sanitizeInvalidProviders()

    expect(outcome.removed).toEqual([])
    expect(outcome.staleGatewayMarkers).toEqual([])
    const cfg = readProvidersFromDisk()['my-custom-llm']
    // provider 级 4 字段（空串 + 纯空白 trim 同视）全部剥除
    for (const key of ['name', 'baseUrl', 'apiKey', 'api']) expect(cfg).not.toHaveProperty(key)
    // 模型级 name/api/baseUrl 剥除；未受影响的模型零改动
    expect(cfg.models).toEqual([{ id: 'm1' }, { id: 'm2', name: 'M2' }])
    // modelOverrides 级 name 剥除（条目本身保留）
    expect(cfg.modelOverrides).toEqual({ 'gpt-4': {} })
    // 盘上无任何空串值（空串键落盘会让 pi 拒载整个 models.json）
    expect(readFileSync(join(agentDir, 'models.json'), 'utf-8')).not.toMatch(/:\s*""/)
  })

  it('D2①: 模型级空串 id → 该模型整条被丢弃（不是只删键）', () => {
    writeModels({
      'my-custom-llm': {
        headers: { 'X-Test': '1' },
        models: [
          { id: 'ok', name: 'OK' },
          { id: '', name: 'Empty', baseUrl: 'https://x.example' },
          { id: '  ', name: 'Blank' },
        ],
      },
    })

    sanitizeInvalidProviders()

    // 空 id 模型无有效标识（id 是 pi 必需字段）——整条丢弃，不留下无 id/空 id 条目
    expect(readProvidersFromDisk()['my-custom-llm'].models).toEqual([{ id: 'ok', name: 'OK' }])
  })

  it('D2②: catalog 条目 api 一律剥除，baseUrl 无标记剥除 / 有标记保留（三对照）', () => {
    writeModels({
      // 无标记：provider 级 api + baseUrl 都是冻结 artifact → 全剥
      opencode: { name: 'OpenCode', headers: { A: '1' }, api: 'anthropic-messages', baseUrl: 'https://frozen.example' },
      // 有标记：用户网关 → baseUrl 保留，api 仍一律剥除
      'opencode-go': { name: 'OpenCode Go', headers: { A: '1' }, api: 'openai-completions', baseUrl: 'https://gw.example' },
    })

    const outcome = sanitizeInvalidProviders(markerReader(['opencode-go']))

    expect(outcome.removed).toEqual([])
    expect(outcome.staleGatewayMarkers).toEqual([])
    const providers = readProvidersFromDisk()
    expect(providers.opencode).not.toHaveProperty('api')
    expect(providers.opencode).not.toHaveProperty('baseUrl')
    expect(providers['opencode-go']).not.toHaveProperty('api')
    expect(providers['opencode-go'].baseUrl).toBe('https://gw.example')
  })

  it('D2②: 写读错位（extras 有标记、models.json 无 baseUrl 键）→ 产出待清清单且不在同步清洗段写盘', () => {
    writeModels({ opencode: { name: 'OpenCode', headers: { A: '1' } } })
    const rawBefore = readFileSync(join(agentDir, 'models.json'), 'utf-8')
    const mtimeBefore = statSync(join(agentDir, 'models.json')).mtimeMs

    const outcome = sanitizeInvalidProviders(markerReader(['opencode']))

    // 待清清单产出（清标记的 async 锁内写由调用方编排——不在同步清洗段执行）
    expect(outcome.staleGatewayMarkers).toEqual(['opencode'])
    // 无剥除、无空壳 → 同步清洗段零写盘，条目逐字节原样
    expect(outcome.removed).toEqual([])
    expect(outcome.repaired).toEqual([])
    expect(statSync(join(agentDir, 'models.json')).mtimeMs).toBe(mtimeBefore)
    expect(readFileSync(join(agentDir, 'models.json'), 'utf-8')).toBe(rawBefore)
  })

  it('D2 顺序契约: 剥键（含丢弃空 id 模型）先于既有空壳判定——剥完只剩 name 的 catalog 条目走既有 MF-5 修复分支', () => {
    writeModels({
      // ① 剥掉空串 baseUrl/api 后只剩 name → 既有八字段全缺判定接管
      'opencode-go': { name: 'OpenCode Go', baseUrl: '', api: '' },
      // ① 丢弃唯一（空 id）模型后 models 变空 → 同样落回既有判定；
      // 若顺序相反（先判定后剥键），该条目会以 models:[] 形态留在盘上，得不到修复
      opencode: { models: [{ id: '' }] },
    })

    const outcome = sanitizeInvalidProviders()

    expect(outcome.removed).toEqual([])
    expect(outcome.repaired.sort()).toEqual(['opencode', 'opencode-go'])
    const providers = readProvidersFromDisk()
    // 剥除先于修复：修复产物不含空串键；name 等既有字段保留；models 从快照合并
    expect(providers['opencode-go'].name).toBe('OpenCode Go')
    expect(providers['opencode-go']).not.toHaveProperty('baseUrl')
    expect(providers['opencode-go']).not.toHaveProperty('api')
    expect((providers['opencode-go'].models as unknown[]).length).toBeGreaterThan(0)
    expect((providers.opencode.models as unknown[]).length).toBeGreaterThan(0)
    // 幂等：第二次调用无剥除/修复（已是合法条目）
    const second = sanitizeInvalidProviders()
    expect(second.removed).toEqual([])
    expect(second.repaired).toEqual([])
  })

  it('D2: 合法条目零触碰（干净文件跑清洗后盘上内容逐字节不变）', () => {
    writeModels({
      opencode: { name: 'OpenCode', baseUrl: 'https://gw.example', headers: { A: '1' } },
      'my-custom-llm': { name: 'Custom', apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
    })
    const rawBefore = readFileSync(join(agentDir, 'models.json'), 'utf-8')

    const outcome = sanitizeInvalidProviders(markerReader(['opencode']))

    expect(outcome.staleGatewayMarkers).toEqual([])
    expect(outcome.removed).toEqual([])
    expect(outcome.repaired).toEqual([])
    expect(readFileSync(join(agentDir, 'models.json'), 'utf-8')).toBe(rawBefore)
  })
})
