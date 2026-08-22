/**
 * provider-config-helper scoped-model 残留清理测试（scoped-model design §4.1 A8 / S8）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi/beforeEach/afterEach，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-config-helper.test.ts
 *
 * A8 语义：deleteProvider 后 scopedModels（providers.json 顶层白名单）中该 provider 的
 * `providerId/` 前缀条目被清，其他 provider 条目保留。
 *
 * 策略：真实 XyzProviderStore（tmpdir providers.json，走 RMW 锁 + 原子写真路径）
 * + mock configStore/authStorage（调用路由断言，模式同 config-service-removebykind.test.ts）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../config-service.js'
import { XyzProviderStore } from '../provider-extras-store.js'
import type { IConfigStore } from '../ports/config.js'
import type { AuthStorage } from '../auth/auth-storage.js'

type FullAuthPick = Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'set' | 'hasCredentialSync' | 'listCredentialIds'>

let dir: string
let extrasPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-config-helper-'))
  extrasPath = join(dir, 'config', 'providers.json')
  mkdirSync(join(dir, 'config'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 预写 providers.json（含顶层 scopedModels 白名单）。 */
function writeScopedModels(scopedModels: string[]): void {
  writeFileSync(extrasPath, JSON.stringify({ version: 1, providers: {}, scopedModels }, null, 2))
}

/** 读回文件态 scopedModels（绕过 store 直接读盘，断言写路径真生效）。 */
function readScopedModels(): string[] {
  return (JSON.parse(readFileSync(extrasPath, 'utf-8')) as { scopedModels?: string[] }).scopedModels ?? []
}

/** 最小 mock IConfigStore（写方法 vi.fn 供断言路由，模式同 config-service-removebykind.test.ts）。 */
function makeStore() {
  return {
    getEnabledModels: vi.fn(() => []),
    getDefaultModel: vi.fn(() => null),
    removeProvider: vi.fn(() => ({ removed: true })),
    cleanEnabledModelsResidue: vi.fn(),
  } as unknown as IConfigStore & {
    removeProvider: ReturnType<typeof vi.fn>
    cleanEnabledModelsResidue: ReturnType<typeof vi.fn>
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

function makeService(): { svc: ConfigService; store: ReturnType<typeof makeStore> } {
  const store = makeStore()
  const svc = new ConfigService('/tmp/project', store, makeAuth(), new XyzProviderStore(extrasPath))
  return { svc, store }
}

describe('A8: deleteProvider 清 scopedModels 残留', () => {
  it('A8 删除 provider 后 scopedModels 中该 provider 前缀条目被清，其他 provider 条目保留', async () => {
    writeScopedModels(['openai/gpt-4', 'anthropic/claude', 'openai/gpt-3.5'])
    const { svc, store } = makeService()

    await svc.deleteProvider('openai')

    // openai/ 前缀两条被清，anthropic 条目保留（读盘断言，非 mock 回显）
    expect(readScopedModels()).toEqual(['anthropic/claude'])
    // 编排路由：models.json 条目删除 + enabledModels 残留清理照旧
    expect(store.removeProvider).toHaveBeenCalledWith('openai')
    expect(store.cleanEnabledModelsResidue).toHaveBeenCalledWith('openai')
  })

  it('A8 无匹配条目时幂等（scopedModels 原样保留）', async () => {
    writeScopedModels(['anthropic/claude'])
    const { svc } = makeService()

    await svc.deleteProvider('openai')

    expect(readScopedModels()).toEqual(['anthropic/claude'])
  })
})
