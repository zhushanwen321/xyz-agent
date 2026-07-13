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
