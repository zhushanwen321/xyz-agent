/**
 * RecentWorkspacesStore 测试
 *
 * 覆盖 execution-plan test-matrix T1.1-T1.8：
 * - T1.1: record 3 cwd → list 返 3 条倒序
 * - T1.2: 11 cwd → 淘汰最旧保 10（INV-2）
 * - T1.3: 同 cwd 多次 → 不重复（INV-3）
 * - T1.4: cwd 空串静默跳过（INV-1 双层守卫）
 * - T1.5: 文件不存在首启 → list 返 [] 不抛
 * - T1.6: 文件损坏非法 JSON → list 返 []（INV-4）
 * - T1.7: debounce：record N 次 advance 500ms → atomicWrite 1 次
 * - T1.8: INV-5 路径含 configDir，无硬编码
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'

// Mock fs-utils atomicWrite to count writes
vi.mock('../src/utils/fs-utils.js', () => ({
  atomicWrite: vi.fn(),
}))

// Mock fs to control readFileSync / existsSync / mkdirSync
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

import { atomicWrite } from '../src/utils/fs-utils.js'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { RecentWorkspacesStore } from '../src/services/workspace/recent-workspaces-store.js'

const mockedAtomicWrite = vi.mocked(atomicWrite)
const mockedReadFileSync = vi.mocked(readFileSync)
const mockedExistsSync = vi.mocked(existsSync)
const mockedMkdirSync = vi.mocked(mkdirSync)

const TEST_CONFIG_DIR = '/home/user/.xyz-agent'

describe('RecentWorkspacesStore', () => {
  let store: RecentWorkspacesStore

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    // 默认：文件不存在（首启场景）
    mockedExistsSync.mockReturnValue(false)
    mockedReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    store = new RecentWorkspacesStore(TEST_CONFIG_DIR)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── T1.1: record 3 个 cwd → list 返 3 条倒序 ──────────────────

  it('T1.1: record 3 cwd → list returns 3 records in reverse order', () => {
    store.record('/project/a')
    vi.advanceTimersByTime(10)
    store.record('/project/b')
    vi.advanceTimersByTime(10)
    store.record('/project/c')

    const list = store.list()
    expect(list).toHaveLength(3)
    // 倒序：最新的在前
    expect(list[0].cwd).toBe('/project/c')
    expect(list[1].cwd).toBe('/project/b')
    expect(list[2].cwd).toBe('/project/a')
    expect(list[0].label).toBe('c')
    expect(list[1].label).toBe('b')
    expect(list[2].label).toBe('a')
  })

  // ── T1.2: 11 个 cwd → 淘汰最旧保 10（INV-2）──────────────────

  it('T1.2: 11 cwd → evicts oldest, keeps 10 (INV-2)', () => {
    for (let i = 1; i <= 11; i++) {
      store.record(`/project/dir-${i}`)
      vi.advanceTimersByTime(10)
    }

    const list = store.list()
    expect(list).toHaveLength(10)
    // 最旧的 dir-1 被淘汰
    expect(list.find(r => r.cwd === '/project/dir-1')).toBeUndefined()
    // 最新的 dir-11 在首位
    expect(list[0].cwd).toBe('/project/dir-11')
  })

  // ── T1.3: 同 cwd 多次 → 不重复（INV-3）───────────────────────

  it('T1.3: same cwd recorded multiple times → no duplicate (INV-3)', () => {
    store.record('/project/same')
    vi.advanceTimersByTime(10)
    store.record('/project/same')
    vi.advanceTimersByTime(10)
    store.record('/project/other')
    vi.advanceTimersByTime(10)
    store.record('/project/same')

    const list = store.list()
    expect(list).toHaveLength(2)
    // 更新后的 same 在首位
    expect(list[0].cwd).toBe('/project/same')
    expect(list[1].cwd).toBe('/project/other')
  })

  // ── T1.4: cwd 空串静默跳过（INV-1 双层守卫）───────────────────

  it('T1.4: empty string cwd silently skipped (INV-1)', () => {
    store.record('')
    store.record('   ')

    expect(store.list()).toHaveLength(0)
  })

  // ── T1.5: 文件不存在首启 → list 返 [] 不抛 ────────────────────

  it('T1.5: file not exist on first launch → list returns [] no throw', () => {
    expect(() => store.list()).not.toThrow()
    expect(store.list()).toEqual([])
  })

  // ── T1.6: 文件损坏非法 JSON → list 返 []（INV-4）───────────────

  it('T1.6: corrupt JSON file → list returns [] (INV-4)', () => {
    mockedReadFileSync.mockReturnValue('not-valid-json{{{')
    mockedExistsSync.mockReturnValue(true)
    // 新建 store 触发 loadPartition
    const corruptStore = new RecentWorkspacesStore(TEST_CONFIG_DIR)
    expect(() => corruptStore.list()).not.toThrow()
    expect(corruptStore.list()).toEqual([])
  })

  // ── T1.7: debounce：record N 次 advance 500ms → atomicWrite 1 次 ─

  it('T1.7: debounce: record N times + advance 500ms → atomicWrite called', () => {
    store.record('/project/a')
    store.record('/project/b')
    store.record('/project/c')

    // debounce 尚未触发
    expect(mockedAtomicWrite).not.toHaveBeenCalled()

    // advance 500ms 触发 flush
    vi.advanceTimersByTime(500)

    // atomicWrite 被调用
    expect(mockedAtomicWrite).toHaveBeenCalled()
    const callCount = mockedAtomicWrite.mock.calls.length

    // 再 advance 不会额外写入（dirty 已清）
    vi.advanceTimersByTime(1000)
    expect(mockedAtomicWrite).toHaveBeenCalledTimes(callCount)
  })

  // ── T1.8: INV-5 路径含 configDir，无硬编码 ────────────────────

  it('T1.8: file path derived from configDir, no hardcoded path (INV-5)', () => {
    store.record('/project/test')
    vi.advanceTimersByTime(500)

    // atomicWrite 应使用 configDir 拼接的路径
    const expectedPath = join(TEST_CONFIG_DIR, 'recent-workspaces.json')
    expect(mockedAtomicWrite).toHaveBeenCalledWith(
      expectedPath,
      expect.any(String),
    )
  })

  it('T1.8b: different configDir → different file path', () => {
    const otherConfigDir = '/tmp/other-config'
    const otherStore = new RecentWorkspacesStore(otherConfigDir)
    otherStore.record('/project/test')
    vi.advanceTimersByTime(500)

    const expectedPath = join(otherConfigDir, 'recent-workspaces.json')
    expect(mockedAtomicWrite).toHaveBeenCalledWith(
      expectedPath,
      expect.any(String),
    )
  })

  // ── T1.10: flushAll 直接持久化不等 debounce ───────────────────

  it('T1.10: flushAll persists immediately without waiting for debounce', () => {
    store.record('/project/a')
    store.record('/project/b')

    expect(mockedAtomicWrite).not.toHaveBeenCalled()

    store.flushAll()

    expect(mockedAtomicWrite).toHaveBeenCalled()
  })

  // ── T1.11: startFlushTimer 定期 flush ─────────────────────────

  it('T1.11: startFlushTimer triggers periodic flushAll', () => {
    store.record('/project/test')
    store.startFlushTimer()

    // 5 秒周期触发
    vi.advanceTimersByTime(5000)
    expect(mockedAtomicWrite).toHaveBeenCalled()
  })
})
