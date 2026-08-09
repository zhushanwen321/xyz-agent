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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findValidDefaultModel, setModelsPath } from '../pi-provider-store.js'
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
  rmSync(dir, { recursive: true, force: true })
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
