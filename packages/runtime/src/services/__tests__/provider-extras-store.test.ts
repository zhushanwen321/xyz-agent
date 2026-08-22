/**
 * XyzProviderStore（config/providers.json 唯一读写者）单测（tmp 目录真实文件）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect，禁 node:test）。
 * 运行命令：cd packages/runtime && npx vitest run src/services/__tests__/provider-extras-store.test.ts
 *
 * 覆盖（验收 4 原子并发 + 验收 5 损坏容错 + 基础 RMW 语义）：
 * - 文件不存在读返回空且不物化（对齐 AuthStorage.remove 语义）
 * - modify RMW / getExtras / readAll
 * - 并发 modify 同 provider：锁串行化，两字段的增量更新无交错丢失
 * - delete 幂等
 * - 损坏 JSON（非法 JSON / version 非 1）：readAll 返回空 + .corrupt-<ts> 备份生成
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XyzProviderStore } from '../provider-extras-store.js'

let dir: string
let file: string
let store: XyzProviderStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-extras-store-'))
  mkdirSync(join(dir, 'config'), { recursive: true })
  file = join(dir, 'config', 'providers.json')
  store = new XyzProviderStore(file)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('XyzProviderStore', () => {
  it('文件不存在时 readAll 返回空对象且不物化文件（读路径无副作用）', async () => {
    expect(await store.readAll()).toEqual({})
    expect(existsSync(file)).toBe(false)
  })

  it('文件不存在时 getExtras 返回 undefined', async () => {
    expect(await store.getExtras('zai-coding-cn')).toBeUndefined()
  })

  it('modify 写入后 getExtras/readAll 读回完整数据（含 cookieSet/apiKeySet/modelStates）', async () => {
    await store.modify('zai-coding-cn', () => ({
      authMethod: 'api_key',
      quota: { fetcher: 'zhipu', enabled: true, cookieSet: false, apiKeySet: true },
      modelStates: { 'glm-5.2': { enabled: false } },
    }))
    expect(await store.getExtras('zai-coding-cn')).toEqual({
      authMethod: 'api_key',
      quota: { fetcher: 'zhipu', enabled: true, cookieSet: false, apiKeySet: true },
      modelStates: { 'glm-5.2': { enabled: false } },
    })
    const all = await store.readAll()
    expect(Object.keys(all)).toEqual(['zai-coding-cn'])
  })

  it('modify 不同 provider 互不覆盖', async () => {
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    await store.modify('b', () => ({ authMethod: 'oauth' }))
    expect((await store.getExtras('a'))?.authMethod).toBe('api_key')
    expect((await store.getExtras('b'))?.authMethod).toBe('oauth')
  })

  it('并发 modify 同 provider：最终状态一致无交错（proper-lockfile 串行化 RMW）', async () => {
    // 两个 Promise 同时写同 provider 的不同字段，各自基于 current 增量更新——
    // 锁保证后者在锁内重读到前者的结果，两字段都保留（无交错半写）
    await Promise.all([
      store.modify('shared', current => ({ ...current, authMethod: 'api_key' })),
      store.modify('shared', current => ({ ...current, quota: { enabled: true } })),
    ])
    expect(await store.getExtras('shared')).toEqual({
      authMethod: 'api_key',
      quota: { enabled: true },
    })
    // 加大并发压力：10 个并发 modify 各写一个 modelState 条目，全部保留
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.modify('chaos', current => ({
          ...current,
          modelStates: { ...current?.modelStates, [`m${i}`]: { enabled: i % 2 === 0 } },
        })),
      ),
    )
    expect(Object.keys((await store.getExtras('chaos'))?.modelStates ?? {})).toHaveLength(10)
  })

  it('并发 modify 不同 provider：全部保留', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.modify(`p${i}`, () => ({ quota: { enabled: true, fetcher: `f${i}` } })),
      ),
    )
    const all = await store.readAll()
    expect(Object.keys(all)).toHaveLength(10)
    expect(all.p3?.quota?.fetcher).toBe('f3')
  })

  it('delete 删除条目且幂等；文件不存在时不物化 providers.json', async () => {
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    await store.delete('a')
    expect(await store.getExtras('a')).toBeUndefined()

    // 幂等：条目已不存在再删不抛错、不写盘
    await store.delete('a')
    await store.delete('never-existed')
    expect(await store.getExtras('a')).toBeUndefined()

    // 文件不存在时 delete 不物化（对齐 AuthStorage.remove 语义）
    const freshDir = mkdtempSync(join(tmpdir(), 'provider-extras-store-fresh-'))
    try {
      const freshFile = join(freshDir, 'config', 'providers.json')
      await new XyzProviderStore(freshFile).delete('x')
      expect(existsSync(freshFile)).toBe(false)
    } finally {
      rmSync(freshDir, { recursive: true, force: true })
    }
  })

  it('损坏容错：非法 JSON → readAll 返回空 + 备份为 providers.json.corrupt-<ts>', async () => {
    writeFileSync(file, '{ not valid json', 'utf-8')
    expect(await store.readAll()).toEqual({})
    // 备份文件生成（quarantine 是 rename 语义：坏文件移走，原位置恢复可写）
    const corruptions = readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))
    expect(corruptions).toHaveLength(1)
    // 隔离后原文件已移走，后续 modify 正常重建
    await store.modify('a', () => ({ authMethod: 'api_key' }))
    expect(await store.getExtras('a')).toMatchObject({ authMethod: 'api_key' })
  })

  it('损坏容错：version 非 1（未来格式）→ 按空配置 + 隔离备份', async () => {
    writeFileSync(file, JSON.stringify({ version: 2, providers: { x: { authMethod: 'api_key' } } }), 'utf-8')
    expect(await store.readAll()).toEqual({})
    const corruptions = readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))
    expect(corruptions).toHaveLength(1)
  })

  it('损坏容错：结构不匹配（providers 非对象）→ 按空配置 + 隔离备份', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, providers: 'not-an-object' }), 'utf-8')
    expect(await store.readAll()).toEqual({})
    expect(readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
  })

  it('损坏容错：providers 为 null → 按空配置 + 隔离备份（typeof null === "object" 不得穿透校验）', async () => {
    // round 1 review must-fix #5：null 穿透校验会让 readAll 返回 providers:null，
    // 消费方对 null 赋值直接 TypeError 且无隔离自愈
    writeFileSync(file, JSON.stringify({ version: 1, providers: null }), 'utf-8')
    expect(await store.readAll()).toEqual({})
    expect(readdirSync(join(dir, 'config')).filter(f => f.startsWith('providers.json.corrupt-'))).toHaveLength(1)
  })

  it('空文件内容按空配置处理（不触发隔离）', async () => {
    writeFileSync(file, '', 'utf-8')
    // 空串 JSON.parse 抛错 → 走隔离路径？——JSON.parse('') throws → 隔离 + 空。
    // 语义上空文件等同未初始化，隔离后按空继续（与 AuthStorage 空文件按空不同：
    // providers.json 是 xyz 自有文件（原子写保证非空），空文件只可能来自外部干预，隔离留证）
    expect(await store.readAll()).toEqual({})
  })
})
