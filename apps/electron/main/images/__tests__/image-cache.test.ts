/**
 * toolResult 图片缓存生命周期测试（crash-resilience §3.3 D6-⑨ / u7-memory-governance，main 侧）。
 *
 * 运行池：guarded（vitest.config projects——真实文件 IO，挂全套 fs-guard；夹具全部
 * mkdtempSync(tmpdir) 自建自删，XYZ_AGENT_DATA_DIR 由 globalSetup 指向 tmp）。
 *
 * 覆盖（设计 A9③ 验收链）：
 * - 幂等写：同内容 hash 命中跳过写（cached），文件内容 = base64 解码原值
 * - 新→旧有序落盘、超帽即停（设计 v8 显式声明）：注入小帽，按新→旧传参，第 1 张落盘、
 *   后续全部 quota-full 且盘上无文件；帽满语义 = 最新图优先可见、更旧图占位
 * - 单 session size 帽：已占目录（预置文件）+ 新图超剩余额度 → 停
 * - 孤儿扫描：mtime 超 30 天 + sessions 目录无对应 session 文件 → 判死删目录；
 *   活 session 目录（有文件）与新鲜孤儿目录保留
 * - 全局软上限：超帽只清孤儿判死目录（活 session 目录豁免），mtime 老→新
 * - session 删除级联：目录删除幂等
 * - 路径穿越防护：非法 sessionId 向上抛（IPC 壳层兜底降级，不落盘）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getImageCacheDir, getImageCacheRoot } from '@xyz-agent/shared/paths'
import {
  deleteSessionImageCache,
  enforceImageCacheGlobalCap,
  scanOrphanImageCaches,
  sessionImageCacheBytes,
  writeImagesNewestFirst,
  IMAGE_CACHE_SESSION_MAX_BYTES,
  IMAGE_CACHE_GLOBAL_SOFT_CAP_BYTES,
} from '../image-cache.js'

const DAY_MS = 24 * 60 * 60 * 1000

let root: string
let sessionsDir: string
/** 软上限用例的独立 dataDir（与前序用例的 cache 目录隔离——软上限扫描全域 cache/images）。 */
let capRoot: string
let capSessionsDir: string

/** utimesSync 参数单位是秒：ageDays 天前的时间戳。 */
function epochSecondsAgo(ageDays: number): number {
  return (Date.now() - ageDays * DAY_MS) / 1000
}

function img(data: string): { data: string; mimeType: string } {
  return { data, mimeType: 'image/png' }
}

/** 生成 N 字节的伪 base64 图（'A' 是合法 base64 字符；4 字符 ≈ 3 字节解码）。 */
function fakeBase64(bytes: number): string {
  return 'A'.repeat(Math.ceil(bytes / 3) * 4)
}

function cacheDirOf(sid: string): string {
  return join(root, 'cache', 'images', sid)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'xyz-image-cache-test-'))
  sessionsDir = join(root, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  capRoot = mkdtempSync(join(tmpdir(), 'xyz-image-cache-cap-'))
  capSessionsDir = join(capRoot, 'sessions')
  mkdirSync(capSessionsDir, { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  rmSync(capRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('写入与幂等', () => {
  it('新图 written：文件内容 = base64 解码原值，路径在 <cache>/<sessionId>/ 下', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const r = writeImagesNewestFirst('s-write', [img(pngBytes.toString('base64'))], { dataDir: root, sessionsDir })
    expect(r.quotaFull).toBe(false)
    expect(r.results).toHaveLength(1)
    const first = r.results[0]!
    expect(first.status).toBe('written')
    expect(first.path!.startsWith(cacheDirOf('s-write'))).toBe(true)
    expect(existsSync(first.path!)).toBe(true)
    expect(readFileSyncBytes(first.path!)).toEqual(pngBytes)
    expect(sessionImageCacheBytes('s-write', { dataDir: root, sessionsDir })).toBe(pngBytes.length)
  })

  it('同内容再次写入：hash 命中 cached 同路径（幂等，不重复落盘）', () => {
    const data = Buffer.from([1, 2, 3]).toString('base64')
    const r1 = writeImagesNewestFirst('s-idem', [img(data)], { dataDir: root, sessionsDir })
    const r2 = writeImagesNewestFirst('s-idem', [img(data)], { dataDir: root, sessionsDir })
    expect(r1.results[0]!.status).toBe('written')
    expect(r2.results[0]!.status).toBe('cached')
    expect(r2.results[0]!.path).toBe(r1.results[0]!.path)
    expect(readdirSync(cacheDirOf('s-idem'))).toHaveLength(1)
  })

  it('invalid 图（data 空）降级 invalid，不阻断批内其他图', () => {
    const r = writeImagesNewestFirst('s-invalid', [img(''), img('QQ==')], { dataDir: root, sessionsDir })
    expect(r.results[0]!.status).toBe('invalid')
    expect(r.results[1]!.status).toBe('written')
    expect(r.quotaFull).toBe(false)
  })
})

describe('新→旧有序落盘、超帽即停（注入小帽）', () => {
  const cap = 1000 // 1000 字节测试帽
  const imgBytes = 600 // 每图 ~600 字节

  it('第 1 张（最新）落盘后剩余额度不足 → 后续（更旧）全部 quota-full，盘上无文件', () => {
    const r = writeImagesNewestFirst(
      's-order',
      [img(fakeBase64(imgBytes)), img(fakeBase64(imgBytes)), img(fakeBase64(imgBytes))],
      { dataDir: root, sessionsDir },
      cap,
    )
    expect(r.results.map((x) => x.status)).toEqual(['written', 'quota-full', 'quota-full'])
    expect(r.quotaFull).toBe(true)
    // 盘上只有最新 1 张
    expect(readdirSync(cacheDirOf('s-order'))).toHaveLength(1)
  })

  it('已占目录计入帽：预置文件吃掉额度后新图停写', () => {
    const sid = 's-preseed'
    const dir = getImageCacheDir(sid, root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'existing.png'), Buffer.alloc(900))
    const r = writeImagesNewestFirst(sid, [img(fakeBase64(imgBytes))], { dataDir: root, sessionsDir }, cap)
    expect(r.results[0]!.status).toBe('quota-full')
  })

  it('默认 64MB 帽常量（设计值）与全局软上限常量（设计值）', () => {
    expect(IMAGE_CACHE_SESSION_MAX_BYTES).toBe(64 * 1024 * 1024)
    expect(IMAGE_CACHE_GLOBAL_SOFT_CAP_BYTES).toBe(512 * 1024 * 1024)
  })
})

describe('孤儿扫描（启动清扫通道②）', () => {
  it('mtime 超 30 天 + sessions 无对应文件 → 判死删目录；活 session / 新鲜孤儿保留', () => {
    // 活 session：sessions 目录有 <sid>.jsonl
    writeFileSync(join(sessionsDir, 'alive.jsonl'), '{}\n')
    mkdirSync(cacheDirOf('alive'), { recursive: true })
    writeFileSync(join(cacheDirOf('alive'), 'a.png'), 'x')
    // 死 session：sessions 无对应文件 + 目录 mtime 40 天前
    mkdirSync(cacheDirOf('dead-old'), { recursive: true })
    writeFileSync(join(cacheDirOf('dead-old'), 'b.png'), 'x')
    utimesSync(cacheDirOf('dead-old'), epochSecondsAgo(40), epochSecondsAgo(40))
    // 新鲜孤儿：无 session 文件但 mtime 新 → 保留
    mkdirSync(cacheDirOf('dead-fresh'), { recursive: true })
    writeFileSync(join(cacheDirOf('dead-fresh'), 'c.png'), 'x')

    const result = scanOrphanImageCaches({ dataDir: root, sessionsDir })
    expect(result.removed).toContain('dead-old')
    expect(result.removed).not.toContain('alive')
    expect(result.removed).not.toContain('dead-fresh')
    expect(existsSync(cacheDirOf('dead-old'))).toBe(false)
    expect(existsSync(cacheDirOf('alive'))).toBe(true)
    expect(existsSync(cacheDirOf('dead-fresh'))).toBe(true)
  })

  it('sessions 目录整体不存在 → 孤儿判据放行不了（判据不可用时不误删）', () => {
    mkdirSync(cacheDirOf('no-sessions-dir'), { recursive: true })
    const missing = join(root, 'sessions-missing')
    const result = scanOrphanImageCaches({ dataDir: root, sessionsDir: missing })
    expect(result.removed).not.toContain('no-sessions-dir')
  })
})

describe('全局软上限 512MB（只清孤儿判死目录，mtime 老→新）', () => {
  function capCacheDirOf(sid: string): string {
    return join(capRoot, 'cache', 'images', sid)
  }

  it('超帽：孤儿老目录先清、孤儿新目录次之、活 session 目录豁免；回落帽下即停', () => {
    // 独立 dataDir（capRoot）隔离：三个 session 各 600B——orphan-old（40 天）、
    // orphan-mid（10 天）、alive-cap（40 天，活 session）
    writeFileSync(join(capSessionsDir, 'alive-cap.jsonl'), '{}\n')
    for (const [sid, ageDays] of [['orphan-old', 40], ['orphan-mid', 10], ['alive-cap', 40]] as const) {
      mkdirSync(capCacheDirOf(sid), { recursive: true })
      writeFileSync(join(capCacheDirOf(sid), 'img.png'), 'x'.repeat(600))
      utimesSync(capCacheDirOf(sid), epochSecondsAgo(ageDays), epochSecondsAgo(ageDays))
    }
    // 帽 1.5KB：总 ~1.8KB 超帽；清 orphan-old（600B）后 ~1.2KB 回落 → orphan-mid 保留
    const result = enforceImageCacheGlobalCap({ dataDir: capRoot, sessionsDir: capSessionsDir }, 1500)
    expect(result.overCap).toBe(true)
    expect(result.removed).toEqual(['orphan-old'])
    expect(existsSync(capCacheDirOf('orphan-old'))).toBe(false)
    expect(existsSync(capCacheDirOf('orphan-mid'))).toBe(true)
    expect(existsSync(capCacheDirOf('alive-cap'))).toBe(true) // 活 session 豁免（即便 mtime 最老）
  })

  it('未超帽：零清理', () => {
    const result = enforceImageCacheGlobalCap({ dataDir: capRoot, sessionsDir: capSessionsDir }, 500 * 1024 * 1024)
    expect(result.overCap).toBe(false)
    expect(result.removed).toEqual([])
  })
})

describe('session 删除级联（通道①）', () => {
  it('删目录；不存在时幂等 no-op', () => {
    mkdirSync(cacheDirOf('s-cascade'), { recursive: true })
    writeFileSync(join(cacheDirOf('s-cascade'), 'd.png'), 'x')
    deleteSessionImageCache('s-cascade', { dataDir: root, sessionsDir })
    expect(existsSync(cacheDirOf('s-cascade'))).toBe(false)
    expect(() => deleteSessionImageCache('s-cascade', { dataDir: root, sessionsDir })).not.toThrow()
  })

  it('非法 sessionId（路径穿越载荷）向上抛——IPC 壳层兜底降级', () => {
    expect(() => deleteSessionImageCache('../evil', { dataDir: root, sessionsDir })).toThrow(/path traversal/)
  })
})

/** helper：读文件字节（readFileSync 未入 guard 破坏名单，读操作放行）。 */
import { readFileSync } from 'node:fs'
function readFileSyncBytes(p: string): Buffer {
  return readFileSync(p)
}

// getImageCacheRoot 冒烟：root 推导一致性（与 getImageCacheDir 同前缀）
describe('路径推导一致性', () => {
  it('session 目录 = root/<sessionId>', () => {
    expect(getImageCacheDir('x', root)).toBe(join(getImageCacheRoot(root), 'x'))
  })
})
