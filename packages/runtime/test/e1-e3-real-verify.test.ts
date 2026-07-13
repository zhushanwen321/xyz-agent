/**
 * E1-E3 real 层验证（CW test gate）。
 * 用真实 ConfigService + PiConfigStore 指向 dev 数据的副本，验证 setProvider/setDefaultModel 后文件落盘。
 * 跑完即清理，不污染 dev 数据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { ConfigService } from '../src/services/config-service.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import {
  setModelsPath,
  refreshModels,
  readModels,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath, readSettings } from '../src/infra/pi/pi-settings-store.js'

const DEV_MODELS = join(homedir(), '.xyz-agent-dev/pi/agent/models.json')
const DEV_SETTINGS = join(homedir(), '.xyz-agent-dev/pi/agent/settings.json')

let tmpDir: string
let configService: ConfigService
let firstProviderId: string
let firstModelId: string | undefined

beforeAll(() => {
  // 跳过条件：dev 无数据
  if (!existsSync(DEV_MODELS)) return

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

describe.skipIf(!existsSync(DEV_MODELS))('E1-E3 real 层持久化验证', () => {
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

    configService.setDefaultModel(firstProviderId, firstModelId)

    const settings = readSettings()
    expect(settings.defaultProvider).toBe(firstProviderId)
    expect(settings.defaultModel).toBe(firstModelId)
  })
})
