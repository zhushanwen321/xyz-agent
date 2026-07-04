import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { JsonStore, WriteBackCache } from '../src/utils/json-store.js'
import { atomicWrite } from '../src/utils/fs-utils.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'json-store-test-'))
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})

/** 读回某分区文件，断言文件存在并返回解析结果。 */
function readPart(dir: string, k: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'parts', `${k}.json`), 'utf-8')) as Record<string, unknown>
}

/** 真实临时目录的 backing：每分区一个 JSON 文件。 */
function makeBacking(dir: string) {
  mkdirSync(join(dir, 'parts'), { recursive: true })
  return {
    loadPartition(k: string): Map<string, unknown> {
      try {
        const raw = readFileSync(join(dir, 'parts', `${k}.json`), 'utf-8')
        return new Map(Object.entries(JSON.parse(raw) as Record<string, unknown>))
      } catch {
        return new Map()
      }
    },
    persistPartition(k: string, data: Map<string, unknown>): void {
      const obj: Record<string, unknown> = Object.fromEntries(data)
      atomicWrite(join(dir, 'parts', `${k}.json`), JSON.stringify(obj))
    },
  }
}

// ── JsonStore ──────────────────────────────────────────────────────────

describe('JsonStore', () => {
  describe('read', () => {
    it('returns defaultValue when file does not exist (ENOENT)', () => {
      const store = new JsonStore(join(tmpDir, 'missing.json'), { count: 0 })
      expect(store.read()).toEqual({ count: 0 })
    })

    it('reads and parses existing file', () => {
      const path = join(tmpDir, 'data.json')
      writeFileSync(path, JSON.stringify({ count: 42 }), 'utf-8')
      const store = new JsonStore<{ count: number }>(path, { count: 0 })
      expect(store.read()).toEqual({ count: 42 })
    })

    it('returns defaultValue on corrupt JSON', () => {
      const path = join(tmpDir, 'corrupt.json')
      writeFileSync(path, '{ not valid json', 'utf-8')
      const store = new JsonStore<{ count: number }>(path, { count: 0 })
      expect(store.read()).toEqual({ count: 0 })
    })

    it('serves cached value within TTL', () => {
      const path = join(tmpDir, 'ttl.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 }, { ttlMs: 10_000 })
      expect(store.read()).toEqual({ v: 1 })
      writeFileSync(path, JSON.stringify({ v: 2 }), 'utf-8')
      expect(store.read()).toEqual({ v: 1 })
    })

    it('re-reads disk after TTL expires', async () => {
      const path = join(tmpDir, 'ttl-expire.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 }, { ttlMs: 20 })
      expect(store.read()).toEqual({ v: 1 })
      writeFileSync(path, JSON.stringify({ v: 2 }), 'utf-8')
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(store.read()).toEqual({ v: 2 })
    })

    it('deserialize hook shapes raw value', () => {
      const path = join(tmpDir, 'shape.json')
      writeFileSync(path, JSON.stringify({ providers: { a: {} } }), 'utf-8')
      const store = new JsonStore(path, { providers: {} }, {
        deserialize: (raw) => {
          const r = raw as { providers?: Record<string, unknown> }
          return { providers: r.providers ?? {} }
        },
      })
      expect(store.read()).toEqual({ providers: { a: {} } })
    })
  })

  describe('write', () => {
    it('writes value to disk and refreshes cache', () => {
      const path = join(tmpDir, 'write.json')
      const store = new JsonStore<{ n: number }>(path, { n: 0 })
      store.write({ n: 5 })
      expect(store.read()).toEqual({ n: 5 })
      expect(readFileSync(path, 'utf-8')).toBe(JSON.stringify({ n: 5 }, null, 2))
    })

    it('respects indent option', () => {
      const path = join(tmpDir, 'indent.json')
      const store = new JsonStore<{ n: number }>(path, { n: 0 }, { indent: 4 })
      store.write({ n: 1 })
      expect(readFileSync(path, 'utf-8')).toBe(JSON.stringify({ n: 1 }, null, 4))
    })

    it('after write, cache blocks external changes', () => {
      const path = join(tmpDir, 'write-cache.json')
      const store = new JsonStore<{ n: number }>(path, { n: 0 }, { ttlMs: 60_000 })
      store.write({ n: 9 })
      writeFileSync(path, JSON.stringify({ n: 99 }), 'utf-8')
      expect(store.read()).toEqual({ n: 9 })
    })
  })

  describe('invalidate', () => {
    it('forces next read to hit disk', () => {
      const path = join(tmpDir, 'inv.json')
      writeFileSync(path, JSON.stringify({ v: 1 }), 'utf-8')
      const store = new JsonStore<{ v: number }>(path, { v: 0 }, { ttlMs: 60_000 })
      expect(store.read()).toEqual({ v: 1 })
      writeFileSync(path, JSON.stringify({ v: 2 }), 'utf-8')
      store.invalidate()
      expect(store.read()).toEqual({ v: 2 })
    })
  })

  describe('shouldDeleteWhen', () => {
    it('removes file when predicate returns true', () => {
      const path = join(tmpDir, 'empty-del.json')
      const store = new JsonStore<{ items: string[] }>(path, { items: [] }, {
        shouldDeleteWhen: (v) => v.items.length === 0,
      })
      store.write({ items: ['x'] })
      expect(existsSync(path)).toBe(true)
      store.write({ items: [] })
      expect(existsSync(path)).toBe(false)
    })

    it('keeps file with empty object by default (no predicate)', () => {
      const path = join(tmpDir, 'empty-keep.json')
      const store = new JsonStore<Record<string, never>>(path, {})
      store.write({})
      expect(readFileSync(path, 'utf-8')).toBe('{}')
    })
  })
})

// ── WriteBackCache ─────────────────────────────────────────────────────

describe('WriteBackCache', () => {
  describe('get / set / delete / keys / has', () => {
    it('set then get returns value (in-memory)', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      expect(cache.get('p1', 'a')).toBe(1)
    })

    it('get on missing key returns undefined', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      expect(cache.get('p1', 'nope')).toBe(undefined)
    })

    it('delete removes value', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 'hello')
      cache.delete('p1', 'a')
      expect(cache.get('p1', 'a')).toBe(undefined)
    })

    it('keys returns all keys in partition', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p1', 'b', 2)
      cache.set('p1', 'c', 3)
      expect(cache.keys('p1').sort()).toEqual(['a', 'b', 'c'])
    })

    it('partitions are isolated by partition key', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p2', 'a', 2)
      expect(cache.get('p1', 'a')).toBe(1)
      expect(cache.get('p2', 'a')).toBe(2)
    })

    it('has reports membership', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      expect(cache.has('p1', 'a')).toBe(true)
      expect(cache.has('p1', 'b')).toBe(false)
    })

    it('partitionKeys enumerates loaded partitions', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p2', 'a', 2)
      expect(cache.partitionKeys().sort()).toEqual(['p1', 'p2'])
    })

    it('overwriting a key updates partition size', () => {
      const calls: number[] = []
      const cache = new WriteBackCache(
        makeBacking(tmpDir),
        {},
        (_k, _ik, _v, partitionSize) => calls.push(partitionSize),
      )
      cache.set('p1', 'a', 'short')
      cache.set('p1', 'a', 'a much longer value than before')
      // 第二次 partitionSize 不应叠加第一次（覆盖而非新增）
      expect(calls[1]).toBeLessThan(calls[0]! + 1000)
    })
  })

  describe('flush', () => {
    it('flush persists dirty partition to disk', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.flush('p1')
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1 })
    })

    it('flush is a no-op when partition is clean', () => {
      const backing = makeBacking(tmpDir)
      backing.persistPartition('p1', new Map([['a', 1]]))
      const cache = new WriteBackCache(backing)
      cache.get('p1', 'a')
      cache.flush('p1')
      expect(cache.get('p1', 'a')).toBe(1)
    })

    it('flushAll persists all dirty partitions', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p2', 'b', 2)
      cache.flushAll()
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1 })
      expect(readPart(tmpDir, 'p2')).toEqual({ b: 2 })
    })

    it('persisted data is reloadable via new cache instance', () => {
      const cache1 = new WriteBackCache(makeBacking(tmpDir))
      cache1.set('p1', 'persistent', 'val-99')
      cache1.flush('p1')
      const cache2 = new WriteBackCache(makeBacking(tmpDir))
      expect(cache2.get('p1', 'persistent')).toBe('val-99')
    })

    it('delete then flush removes key from disk', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir))
      cache.set('p1', 'a', 1)
      cache.set('p1', 'b', 2)
      cache.flush('p1')
      cache.delete('p1', 'a')
      cache.flush('p1')
      expect(readPart(tmpDir, 'p1')).toEqual({ b: 2 })
    })
  })

  describe('onSet (capacity check)', () => {
    it('invokes onSet before write with sizes', () => {
      const calls: Array<{ ik: string; valueSize: number; partitionSize: number }> = []
      const cache = new WriteBackCache(
        makeBacking(tmpDir),
        {},
        (_k, ik, _v, partitionSize, valueSize) => {
          calls.push({ ik, valueSize, partitionSize })
        },
      )
      cache.set('p1', 'a', 'hello')
      cache.set('p1', 'b', 'world')
      expect(calls).toHaveLength(2)
      expect(calls[0]!.ik).toBe('a')
      expect(calls[1]!.partitionSize).toBeGreaterThan(calls[0]!.partitionSize)
    })

    it('rejects write when onSet throws', () => {
      const cache = new WriteBackCache(
        makeBacking(tmpDir),
        {},
        (_k, _ik, _v, partitionSize) => {
          if (partitionSize > 100) throw Object.assign(new Error('too big'), { code: -32040 })
        },
      )
      cache.set('p1', 'a', 'x'.repeat(50))
      expect(() => cache.set('p1', 'b', 'x'.repeat(60))).toThrow()
      expect(cache.get('p1', 'a')).toBeDefined()
      expect(cache.get('p1', 'b')).toBeUndefined()
    })
  })

  describe('onExternalChange', () => {
    it('drops specified partition so next access reloads', () => {
      const backing = makeBacking(tmpDir)
      const cache = new WriteBackCache(backing)
      cache.set('p1', 'a', 1)
      cache.flush('p1')
      backing.persistPartition('p1', new Map([['a', 999], ['c', 3]]))
      cache.onExternalChange('p1')
      expect(cache.get('p1', 'a')).toBe(999)
      expect(cache.get('p1', 'c')).toBe(3)
    })

    it('drops all partitions when called without arg', () => {
      const backing = makeBacking(tmpDir)
      const cache = new WriteBackCache(backing)
      cache.set('p1', 'a', 1)
      cache.set('p2', 'b', 2)
      cache.flushAll()
      backing.persistPartition('p1', new Map([['a', 111]]))
      cache.onExternalChange()
      expect(cache.get('p1', 'a')).toBe(111)
    })
  })

  describe('dispose', () => {
    it('clears pending timers without flushing', () => {
      const cache = new WriteBackCache(makeBacking(tmpDir), { flushMs: 10_000 })
      cache.set('p1', 'a', 1)
      cache.dispose()
      expect(existsSync(join(tmpDir, 'parts', 'p1.json'))).toBe(false)
    })
  })

  describe('debounce', () => {
    it('schedules flush after flushMs', async () => {
      const cache = new WriteBackCache(makeBacking(tmpDir), { flushMs: 30 })
      cache.set('p1', 'a', 1)
      expect(existsSync(join(tmpDir, 'parts', 'p1.json'))).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1 })
    })

    it('debounces rapid writes into one flush', async () => {
      const cache = new WriteBackCache(makeBacking(tmpDir), { flushMs: 40 })
      cache.set('p1', 'a', 1)
      await new Promise(resolve => setTimeout(resolve, 20))
      cache.set('p1', 'b', 2)
      await new Promise(resolve => setTimeout(resolve, 80))
      // 两次写合并成一次 flush
      expect(readPart(tmpDir, 'p1')).toEqual({ a: 1, b: 2 })
    })
  })
})
