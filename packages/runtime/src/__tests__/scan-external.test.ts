/**
 * scanExternalSessions 外部目录扫描原语测试（import-session D3 / U1）。
 *
 * 锁定行为：
 * - 正常 .jsonl（首行合法 session header）被扫出，id/cwd/name 字段取自文件内容
 * - `.tmp-migrate-` / `.tmp-import-` 标记文件被 isScannableSessionFile 过滤
 *   （D1/r2-S1：候选侧与清扫侧同规则，扫描器从机制上看不到任何非 final 名文件）
 * - 一层子目录内文件被扫出；两层深目录静默跳过（D3/S8 深度假设）
 * - 独立 TTL 缓存：默认读命中快照、force 绕过强制重扫（与太极根 scanDirCache 互不污染）
 * - items 按 lastModified 降序（与 scanPiSessions 一致）
 * - cleanupTmpMigrateResidue 家族扩展：`.tmp-import-` 残留与 `.tmp-migrate-` 同规则清扫
 *
 * 断言锚定外部夹具事实：期望值只来自手写 JSONL 内容，不从实现内部状态断言。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupTmpMigrateResidue, scanExternalSessions } from '../infra/pi/session-file-utils.js'

let rootDir: string

/** 手写合法 session JSONL：首行 header（type/id/cwd/timestamp）+ session_info name 行。 */
function writeSessionJsonl(filePath: string, id: string, cwd: string, name: string): void {
  const lines = [
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-01-01T00:00:00.000Z', version: 1 }),
    JSON.stringify({ type: 'session_info', name }),
    '',
  ]
  writeFileSync(filePath, lines.join('\n'))
}

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'scan-external-'))
})

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('scanExternalSessions', () => {
  it('扫出顶层正常文件，meta 字段取自文件内容', async () => {
    writeSessionJsonl(join(rootDir, 'alpha.jsonl'), 'id-alpha-111', '/tmp/proj-alpha', 'Alpha')
    const { items, rootDir: echoed } = await scanExternalSessions(rootDir, { force: true })
    expect(echoed).toBe(rootDir)
    const alpha = items.find((m) => m.id === 'id-alpha-111')
    expect(alpha).toBeDefined()
    expect(alpha!.cwd).toBe('/tmp/proj-alpha')
    expect(alpha!.name).toBe('Alpha')
    expect(alpha!.filePath).toBe(join(rootDir, 'alpha.jsonl'))
  })

  it('.tmp-migrate- / .tmp-import- 标记文件不出现在结果中（正常文件不受波及）', async () => {
    writeSessionJsonl(join(rootDir, 'a.jsonl.tmp-migrate-123.jsonl'), 'id-tmp-mig', '/tmp/x', 'TmpMig')
    writeSessionJsonl(join(rootDir, 'b.jsonl.tmp-import-456.jsonl'), 'id-tmp-imp', '/tmp/x', 'TmpImp')
    const { items } = await scanExternalSessions(rootDir, { force: true })
    expect(items.some((m) => m.id === 'id-tmp-mig')).toBe(false)
    expect(items.some((m) => m.id === 'id-tmp-imp')).toBe(false)
    expect(items.some((m) => m.id === 'id-alpha-111')).toBe(true)
  })

  it('首行非 session header 的 .jsonl 不收录（按内容识别，非仅文件名）', async () => {
    writeFileSync(join(rootDir, 'notes.jsonl'), 'not a session header line\n')
    const { items } = await scanExternalSessions(rootDir, { force: true })
    expect(items.some((m) => m.filePath.endsWith('notes.jsonl'))).toBe(false)
  })

  it('一层子目录内文件被扫出，两层深目录静默跳过', async () => {
    const sub = join(rootDir, 'proj-sub')
    mkdirSync(sub, { recursive: true })
    writeSessionJsonl(join(sub, 'sub.jsonl'), 'id-sub-333', '/tmp/proj-sub', 'Sub')
    const deep = join(rootDir, 'proj-sub', 'nested')
    mkdirSync(deep, { recursive: true })
    writeSessionJsonl(join(deep, 'deep.jsonl'), 'id-deep-444', '/tmp/deep', 'Deep')
    const { items } = await scanExternalSessions(rootDir, { force: true })
    expect(items.some((m) => m.id === 'id-sub-333')).toBe(true)
    expect(items.some((m) => m.id === 'id-deep-444')).toBe(false)
  })

  it('items 按 lastModified 降序排列', async () => {
    const f1 = join(rootDir, 'older.jsonl')
    writeSessionJsonl(f1, 'id-older-555', '/tmp/sort', 'Older')
    const f2 = join(rootDir, 'newer.jsonl')
    writeSessionJsonl(f2, 'id-newer-666', '/tmp/sort', 'Newer')
    const oldTime = new Date(Date.now() - 60_000)
    utimesSync(f1, oldTime, oldTime)
    const { items } = await scanExternalSessions(rootDir, { force: true })
    const idxOlder = items.findIndex((m) => m.id === 'id-older-555')
    const idxNewer = items.findIndex((m) => m.id === 'id-newer-666')
    expect(idxOlder).toBeGreaterThan(-1)
    expect(idxNewer).toBeGreaterThan(-1)
    expect(idxNewer).toBeLessThan(idxOlder)
  })

  it('独立 TTL 缓存：默认读命中快照，force 绕过强制重扫', async () => {
    // 独立目录：排除本文件其他用例写入对缓存断言的干扰
    const cacheDir = mkdtempSync(join(tmpdir(), 'scan-external-cache-'))
    try {
      writeSessionJsonl(join(cacheDir, 'cache-a.jsonl'), 'id-cache-a', '/tmp/c', 'CacheA')
      const first = await scanExternalSessions(cacheDir) // miss → 重扫并写缓存
      expect(first.items.some((m) => m.id === 'id-cache-a')).toBe(true)
      writeSessionJsonl(join(cacheDir, 'cache-b.jsonl'), 'id-cache-b', '/tmp/c', 'CacheB')
      const second = await scanExternalSessions(cacheDir) // 1s TTL 窗口内 → 命中 pre-write 快照
      expect(second.items.some((m) => m.id === 'id-cache-b')).toBe(false)
      const forced = await scanExternalSessions(cacheDir, { force: true })
      expect(forced.items.some((m) => m.id === 'id-cache-b')).toBe(true)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('根目录不存在 → items 为空，不抛错', async () => {
    const { items, rootDir: echoed } = await scanExternalSessions(join(rootDir, 'no-such-dir'))
    expect(items).toEqual([])
    expect(echoed).toBe(join(rootDir, 'no-such-dir'))
  })
})

describe('cleanupTmpMigrateResidue（.tmp-import- 家族扩展）', () => {
  it('.tmp-import- 残留与 .tmp-migrate- 同规则清扫：过期删、新鲜留、正常文件不碰', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-external-cleanup-'))
    try {
      const staleImport = join(dir, 'x.jsonl.tmp-import-111.jsonl')
      const staleMigrate = join(dir, 'y.jsonl.tmp-migrate-222.jsonl')
      const freshImport = join(dir, 'z.jsonl.tmp-import-333.jsonl')
      const normal = join(dir, 'keep.jsonl')
      writeFileSync(staleImport, 'x')
      writeFileSync(staleMigrate, 'y')
      writeFileSync(freshImport, 'z')
      writeFileSync(normal, 'n')
      // stale 残留拨老 2h（> 默认 1h maxAge）；fresh 保持刚写入的 mtime
      const oldTime = new Date(Date.now() - 7_200_000)
      utimesSync(staleImport, oldTime, oldTime)
      utimesSync(staleMigrate, oldTime, oldTime)

      const removed = cleanupTmpMigrateResidue(dir)
      expect(removed).toBe(2)
      expect(existsSync(staleImport)).toBe(false)
      expect(existsSync(staleMigrate)).toBe(false)
      expect(existsSync(freshImport)).toBe(true)
      expect(existsSync(normal)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('一层子目录内的两前缀残留同样被清扫，返回合计删除数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-external-cleanup-sub-'))
    try {
      const sub = join(dir, 'proj-x')
      mkdirSync(sub, { recursive: true })
      const staleSub = join(sub, 's.jsonl.tmp-import-444.jsonl')
      writeFileSync(staleSub, 's')
      const oldTime = new Date(Date.now() - 7_200_000)
      utimesSync(staleSub, oldTime, oldTime)
      const removed = cleanupTmpMigrateResidue(dir)
      expect(removed).toBe(1)
      expect(existsSync(staleSub)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
