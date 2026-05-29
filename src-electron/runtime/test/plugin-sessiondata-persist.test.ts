/**
 * SessionData 文件持久化 — persist/load/delete + 10MB 限制
 *
 * 测试 plugin-storage.ts 中的 3 个独立导出函数:
 * persistSessionData, loadSessionData, deleteSessionData
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// We'll test via PluginService's flushSessionData internals which call
// the new persistSessionData/loadSessionData/deleteSessionData functions.
// But first let's test the functions directly once they're exported.

// The functions will be exported from plugin-storage.ts
import {
  persistSessionData,
  loadSessionData,
  deleteSessionData,
} from '../src/services/plugin-service/plugin-storage.js'

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'sd-persist-test-'))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

describe('SessionData file persistence', () => {
  it('persist and load roundtrip', async () => {
    const data = new Map<string, unknown>([
      ['key1', 'value1'],
      ['key2', { nested: true, count: 42 }],
    ])

    await persistSessionData(testDir, 'sess-1', data)
    const loaded = await loadSessionData(testDir, 'sess-1')

    expect(loaded).toBeInstanceOf(Map)
    expect(loaded.get('key1')).toBe('value1')
    expect(loaded.get('key2')).toEqual({ nested: true, count: 42 })
  })

  it('load returns empty Map when no file exists', async () => {
    const loaded = await loadSessionData(testDir, 'nonexistent')
    expect(loaded).toBeInstanceOf(Map)
    expect(loaded.size).toBe(0)
  })

  it('delete removes the file', async () => {
    const data = new Map<string, unknown>([['k', 'v']])
    await persistSessionData(testDir, 'sess-del', data)

    // File should exist
    const filePath = join(testDir, 'session-data', 'sess-del.json')
    await expect(stat(filePath)).resolves.toBeDefined()

    await deleteSessionData(testDir, 'sess-del')

    // File should be gone
    await expect(stat(filePath)).rejects.toThrow()
  })

  it('delete does not throw when file does not exist', async () => {
    // Should resolve without error
    await expect(deleteSessionData(testDir, 'nonexistent')).resolves.toBeUndefined()
  })

  it('throws on data exceeding 10MB', async () => {
    // Create data just over 10MB
    const bigValue = 'x'.repeat(10 * 1024 * 1024 + 1)
    const data = new Map<string, unknown>([['big', bigValue]])

    await expect(persistSessionData(testDir, 'huge', data)).rejects.toThrow(/10MB/)
  })

  it('overwrites existing data on re-persist', async () => {
    const data1 = new Map<string, unknown>([['a', 1]])
    const data2 = new Map<string, unknown>([['b', 2]])

    await persistSessionData(testDir, 'sess-ow', data1)
    await persistSessionData(testDir, 'sess-ow', data2)

    const loaded = await loadSessionData(testDir, 'sess-ow')
    expect(loaded.size).toBe(1)
    expect(loaded.get('b')).toBe(2)
  })

  it('handles empty Map', async () => {
    const data = new Map<string, unknown>()
    await persistSessionData(testDir, 'empty', data)

    const loaded = await loadSessionData(testDir, 'empty')
    expect(loaded.size).toBe(0)
  })
})
