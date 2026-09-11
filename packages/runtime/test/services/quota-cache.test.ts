/**
 * QuotaCache 单测 — removeEntry 三语义（coding-plan-quota-config-ux §7.3 改动 4）。
 *
 * removeEntry 服务于「configure 检测 fetcher 变更时清该 provider 条目」：额度缓存按
 * provider 存储、不含类型，不清旧行会被 getCached 原样取回并以新类型标签展示。
 *
 * 三语义（缺一即失效，设计原文）：
 * ① 与 update 共用 writeChain 串行化——remove 的读-删-写与并发 update 的读-改-写
 *    互不覆盖，且链上 FIFO（remove 后紧跟的 update 同 pid 不会被删）；
 * ② memoryCache 同步删——flush 后 getEntry 的内存命中与 miss-reload 两个方向都
 *    不再供旧值（只删磁盘 → 内存镜像继续供旧值；只删内存 → miss-reload 从磁盘还原）；
 * ③ 幂等——条目不存在视为成功，且不物化 quota-cache.json。
 *
 * 项目红线：测试禁触真实数据目录——写删目标 mkdtempSync 自建自删。
 *
 * 运行：cd packages/runtime && npx vitest run test/services/quota-cache.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaCache } from '../../src/services/quota-cache.js'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'

let tmpDir: string
let cache: QuotaCache
let cachePath: string

/** 等待 writeChain flush（update/removeEntry 把同步实现串到微任务链，setImmediate 足够排空）。 */
const flushWriteChain = () => new Promise<void>((resolve) => setImmediate(resolve))

function makeRow(label: string): NormalizedQuotaRow {
  return {
    label,
    wins: [
      { pct: 10, resetSec: 100 },
      { pct: null, resetSec: null },
      { pct: null, resetSec: null },
    ],
  }
}

/** 读磁盘侧 providers 键集合（文件不存在返回 undefined，断言「不物化」用）。 */
function readDiskProviderIds(): string[] | undefined {
  if (!existsSync(cachePath)) return undefined
  return Object.keys(JSON.parse(readFileSync(cachePath, 'utf-8')).providers)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quota-cache-'))
  cache = new QuotaCache(tmpDir)
  cachePath = join(tmpDir, 'quota-cache.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('QuotaCache.removeEntry — 语义① writeChain 串行化', () => {
  it('并发 update(其他 pid) 与 removeEntry 不互相覆盖：两者各自正确落地', async () => {
    // 预置 p-b 落盘
    cache.update('p-b', makeRow('b-old'))
    await flushWriteChain()

    // 同 tick：update p-a 入队 + removeEntry p-b 入队（读-删-写与读-改-写必须互不交错）
    cache.update('p-a', makeRow('a'))
    cache.removeEntry('p-b')
    await flushWriteChain()

    expect(cache.getEntry('p-a')?.data.label).toBe('a')
    expect(cache.getEntry('p-b')).toBeNull()
    // 磁盘侧同样只留 p-a（若 remove 基于陈旧读整文件覆盖，p-a 会丢）
    expect(readDiskProviderIds()).toEqual(['p-a'])
  })

  it('链上 FIFO：removeEntry 后紧跟 update 同 pid → 新数据在（删除不被后写覆盖丢失时序）', async () => {
    cache.update('p-x', makeRow('old'))
    await flushWriteChain()

    cache.removeEntry('p-x')
    cache.update('p-x', makeRow('new'))
    await flushWriteChain()

    // remove 先入队先执行、update 后入队后执行——最终新数据在（FIFO 语义）
    expect(cache.getEntry('p-x')?.data.label).toBe('new')
    expect(readDiskProviderIds()).toEqual(['p-x'])
  })
})

describe('QuotaCache.removeEntry — 语义② memoryCache 同步删（两方向不供旧值）', () => {
  it('删除后 getEntry 内存命中与 miss-reload 都不再返回旧行', async () => {
    cache.update('p-ghost', makeRow('old-row'))
    await flushWriteChain()
    // 先加载内存镜像（getEntry 命中内存，此后命中路径零磁盘读）
    expect(cache.getEntry('p-ghost')?.data.label).toBe('old-row')

    cache.removeEntry('p-ghost')
    await flushWriteChain()

    // 内存命中路径：镜像已删 → null；miss-reload 路径：磁盘已删 → 不还原。
    // （若实现只删磁盘：内存镜像继续供旧值；只删内存：miss-reload 从磁盘把旧行读回）
    expect(cache.getEntry('p-ghost')).toBeNull()
    expect(readDiskProviderIds()).toEqual([])
  })

  it('删除不会被后续其他 provider 的写盘还原（镜像=磁盘口径统一）', async () => {
    cache.update('p-del', makeRow('del'))
    cache.update('p-keep', makeRow('keep'))
    await flushWriteChain()

    cache.removeEntry('p-del')
    await flushWriteChain()
    // 删除后的任意后续写盘（其他 pid 的 doUpdate 重写整文件）不得复活 p-del
    cache.update('p-keep', makeRow('keep-2'))
    await flushWriteChain()

    expect(cache.getEntry('p-del')).toBeNull()
    expect(cache.getEntry('p-keep')?.data.label).toBe('keep-2')
  })
})

describe('QuotaCache.removeEntry — 语义③ 幂等', () => {
  it('条目不存在时调用成功且不物化 quota-cache.json', async () => {
    cache.removeEntry('never-existed')
    await flushWriteChain()

    expect(cache.getEntry('never-existed')).toBeNull()
    // 读路径不物化文件（对齐 XyzProviderStore.delete 的「无内容不产生文件」语义）
    expect(existsSync(cachePath)).toBe(false)
  })

  it('重复删除已删条目仍成功（幂等，不抛）', async () => {
    cache.update('p-once', makeRow('once'))
    await flushWriteChain()

    cache.removeEntry('p-once')
    await flushWriteChain()
    expect(() => {
      cache.removeEntry('p-once')
    }).not.toThrow()
    await flushWriteChain()

    expect(cache.getEntry('p-once')).toBeNull()
    // 文件已物化（曾有条目），幂等删除后 providers 为空对象而非删除文件
    expect(readDiskProviderIds()).toEqual([])
  })
})
