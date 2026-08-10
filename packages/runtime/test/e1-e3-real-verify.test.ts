/**
 * E1-E3 real 层验证（CW test gate）。
 * 用真实 ConfigService + PiConfigStore 指向 dev 数据的副本，验证 setProvider/setDefaultModel 后文件落盘。
 * 跑完即清理，不污染 dev 数据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { ConfigService } from '../src/services/config-service.js'
import type { ProviderId } from '@xyz-agent/shared'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import {
  setModelsPath,
  refreshModels,
  readModels,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath, readSettings } from '../src/infra/pi/pi-settings-store.js'

const DEV_MODELS = join(homedir(), '.xyz-agent-dev/pi/agent/models.json')
const DEV_SETTINGS = join(homedir(), '.xyz-agent-dev/pi/agent/settings.json')

// 跳过条件：dev 无 models.json 或 providers 空。CI 无 dev 文件 → 跳过；
// 本地 dev providers 空（如未配置 provider）→ 也跳过，否则 listProviders()
// 返回 [] 会让 E1 的 find() 落空抛 TypeError（测试设计缺陷修复）。
function devHasProviders(): boolean {
  if (!existsSync(DEV_MODELS)) return false
  try {
    const raw = JSON.parse(readFileSync(DEV_MODELS, 'utf8'))
    return Object.keys(raw?.providers ?? {}).length > 0
  } catch {
    return false
  }
}
const HAS_DEV_PROVIDERS = devHasProviders()

let tmpDir: string
let configService: ConfigService
let firstProviderId: string
let firstModelId: string | undefined

beforeAll(() => {
  // 跳过条件：dev 无可用 provider 数据（providers 空）
  if (!HAS_DEV_PROVIDERS) return

  tmpDir = mkdtempSync(join(tmpdir(), 'e1-e3-real-'))
  const piAgentDir = join(tmpDir, 'pi', 'agent')
  mkdirSync(piAgentDir, { recursive: true })
  copyFileSync(DEV_MODELS, join(piAgentDir, 'models.json'))
  if (existsSync(DEV_SETTINGS)) copyFileSync(DEV_SETTINGS, join(piAgentDir, 'settings.json'))

  setModelsPath(join(piAgentDir, 'models.json'))
  setSettingsPath(join(piAgentDir, 'settings.json'))
  refreshModels()

  const configStore = new PiConfigStore()
  configService = new ConfigService(tmpDir, configStore)

  const providers = configService.listProviders()
  firstProviderId = providers[0]?.id ?? ''
  firstModelId = providers[0]?.models[0]?.id
})

afterAll(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

describe.skipIf(!HAS_DEV_PROVIDERS)('E1-E3 real 层持久化验证', () => {
  it('E1: setProvider 改 api 类型 → models.json 落盘 pi 终值', () => {
    const before = configService.listProviders().find(p => p.id === firstProviderId)!
    const newApi = before.api === 'anthropic-messages' ? 'openai-completions' : 'anthropic-messages'
    configService.setProvider(firstProviderId, { type: newApi })

    const afterProvider = configService.listProviders().find(p => p.id === firstProviderId)!
    expect(afterProvider.api).toBe(newApi)

    // 直接读盘验证（绕过缓存）
    const raw = readModels()
    expect(raw.providers[firstProviderId]?.api).toBe(newApi)
  })

  it('E2: setProvider 改 enabled → models.json 落盘 enabled', () => {
    configService.setProvider(firstProviderId, { enabled: false })

    const afterProvider = configService.listProviders().find(p => p.id === firstProviderId)!
    expect(afterProvider.enabled).toBe(false)

    // 直接读盘验证
    const raw = readModels()
    expect(raw.providers[firstProviderId]?.enabled).toBe(false)

    // 恢复
    configService.setProvider(firstProviderId, { enabled: true })
  })

  it('E3: setDefaultModel → settings.json 落盘 defaultProvider/defaultModel', () => {
    if (!firstModelId) return // provider 无 model，跳过

    configService.setDefaultModel(firstProviderId as ProviderId, firstModelId)

    const settings = readSettings()
    expect(settings.defaultProvider).toBe(firstProviderId)
    expect(settings.defaultModel).toBe(firstModelId)
  })
})
