import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginStorage } from '../src/services/plugin-service/plugin-storage.js'

let tmpDir: string
let storage: PluginStorage

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-storage-test-'))
  storage = new PluginStorage()
  await storage.init(tmpDir, '/test/project')
})

after(async () => {
  await storage.flushAll()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('PluginStorage', () => {
  // ── TC-5-01: get/set basic KV operations ──────────────────────
  it('TC-5-01: get/set basic KV operations', async () => {
    const pluginId = 'test-getset'

    // get 对不存在的 key 返回 undefined
    const missing = await storage.get(pluginId, 'nonexistent')
    assert.strictEqual(missing, undefined)

    // set → get
    await storage.set(pluginId, 'name', 'hello')
    const val = await storage.get(pluginId, 'name')
    assert.strictEqual(val, 'hello')

    // 覆盖写入
    await storage.set(pluginId, 'name', 'world')
    const updated = await storage.get(pluginId, 'name')
    assert.strictEqual(updated, 'world')
  })

  // ── TC-5-02: delete key ───────────────────────────────────────
  it('TC-5-02: delete key', async () => {
    const pluginId = 'test-delete'

    await storage.set(pluginId, 'toDelete', 42)
    const before = await storage.get(pluginId, 'toDelete')
    assert.strictEqual(before, 42)

    await storage.delete(pluginId, 'toDelete')
    const after = await storage.get(pluginId, 'toDelete')
    assert.strictEqual(after, undefined)
  })

  // ── TC-5-03: keys() returns all keys ──────────────────────────
  it('TC-5-03: keys() returns all keys', async () => {
    const pluginId = 'test-keys'

    await storage.set(pluginId, 'a', 1)
    await storage.set(pluginId, 'b', 2)
    await storage.set(pluginId, 'c', 3)

    const allKeys = await storage.keys(pluginId)
    allKeys.sort()
    assert.deepStrictEqual(allKeys, ['a', 'b', 'c'])
  })

  // ── TC-5-04: flush persists to disk, readable after restart ───
  it('TC-5-04: flush persists to disk, readable after restart', async () => {
    const pluginId = 'test-persist'

    await storage.set(pluginId, 'persistent', 'value-123')
    await storage.flush(pluginId)

    // 验证文件已写入
    const filePath = join(tmpDir, 'plugins', pluginId, 'globalState.json')
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, string>
    assert.strictEqual(parsed.persistent, 'value-123')

    // 新实例读取应能恢复数据
    const storage2 = new PluginStorage()
    await storage2.init(tmpDir, '/test/project')
    const restored = await storage2.get(pluginId, 'persistent')
    assert.strictEqual(restored, 'value-123')
  })

  // ── TC-5-05: rejects writes exceeding limit ───────────────────
  it('TC-5-05: rejects writes exceeding value size limit (1MB)', async () => {
    const pluginId = 'test-limit'
    // JSON.stringify 会给字符串加引号，所以实际 > 1MB
    const bigValue = 'x'.repeat(1024 * 1024 + 2)

    await assert.rejects(
      () => storage.set(pluginId, 'big', bigValue),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.strictEqual((err as unknown as { code: number }).code, -32021)
        return true
      },
    )
  })
})
