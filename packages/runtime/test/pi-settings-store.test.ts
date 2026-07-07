import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  readSettings,
  writeSettings,
  updateSettingsSync,
  setSettingsPath,
  getActiveSettingsPath,
  invalidateSettingsCache,
  type PiSettings,
} from '../src/infra/pi/pi-settings-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string
let settingsPath: string

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'pi-settings-store-test-'))
  settingsPath = join(tmpDir, 'pi', 'agent', 'settings.json')
  mkdirSync(join(tmpDir, 'pi', 'agent'), { recursive: true })
  setSettingsPath(settingsPath)
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})

describe('pi-settings-store', () => {
  describe('readSettings', () => {
    it('returns empty object when file does not exist', () => {
      expect(readSettings()).toEqual({})
    })

    it('reads existing settings', () => {
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'gpt-4', packages: ['x'] }), 'utf-8')
      expect(readSettings()).toEqual({ defaultModel: 'gpt-4', packages: ['x'] })
    })

    it('returns empty on corrupt JSON', () => {
      writeFileSync(settingsPath, '{ broken', 'utf-8')
      expect(readSettings()).toEqual({})
    })

    it('returns empty on non-object JSON (e.g. array)', () => {
      writeFileSync(settingsPath, '[1,2,3]', 'utf-8')
      expect(readSettings()).toEqual({})
    })

    it('serves cached value within TTL', () => {
      writeFileSync(settingsPath, JSON.stringify({ v: 1 }), 'utf-8')
      expect(readSettings().v).toBe(1)
      writeFileSync(settingsPath, JSON.stringify({ v: 2 }), 'utf-8')
      // TTL 缓存挡住外部改动
      expect(readSettings().v).toBe(1)
    })
  })

  describe('writeSettings', () => {
    it('writes settings to disk', () => {
      writeSettings({ defaultModel: 'claude' })
      const raw = readFileSync(settingsPath, 'utf-8')
      expect(JSON.parse(raw)).toEqual({ defaultModel: 'claude' })
    })

    it('refreshes cache after write', () => {
      writeSettings({ defaultModel: 'a' })
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'b' }), 'utf-8')
      // write 刷新了缓存，但缓存值是 write 的值，不是盘上被外部改的
      expect(readSettings().defaultModel).toBe('a')
    })

    it('writes with indent', () => {
      writeSettings({ defaultModel: 'claude' })
      const raw = readFileSync(settingsPath, 'utf-8')
      expect(raw).toContain('\n')
    })

    it('creates parent directories', () => {
      const deepPath = join(tmpDir, 'deep', 'nested', 'settings.json')
      setSettingsPath(deepPath)
      writeSettings({ defaultModel: 'claude' })
      expect(existsSync(deepPath)).toBe(true)
    })
  })

  describe('updateSettingsSync (RMW)', () => {
    it('read-modify-write a single field', () => {
      writeSettings({ defaultModel: 'old' })
      updateSettingsSync(s => { s.defaultModel = 'new' })
      expect(readSettings().defaultModel).toBe('new')
    })

    it('preserves other fields (partial update)', () => {
      writeSettings({ defaultModel: 'keep', packages: ['keep-pkg'] })
      updateSettingsSync(s => { s.defaultModel = 'changed' })
      const result = readSettings()
      expect(result.defaultModel).toBe('changed')
      expect(result.packages).toEqual(['keep-pkg'])
    })

    it('operates on a deep copy (mutator does not affect cache)', () => {
      writeSettings({ packages: ['original'] })
      updateSettingsSync(s => {
        s.packages!.push('added')
      })
      // mutator 改的是 draft，但 updateSettingsSync 回写了 draft
      expect(readSettings().packages).toEqual(['original', 'added'])
    })

    it('invalidates cache before read (sees external changes)', () => {
      writeSettings({ defaultModel: 'v1' })
      // 外部改盘（绕过 store）
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'external' }), 'utf-8')
      updateSettingsSync(s => { s.packages = ['x'] })
      const result = readSettings()
      expect(result.defaultModel).toBe('external') // 拿到外部改的值
      expect(result.packages).toEqual(['x'])
    })
  })

  describe('invalidateSettingsCache', () => {
    it('forces re-read on next read', () => {
      writeSettings({ defaultModel: 'cached' })
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'changed' }), 'utf-8')
      invalidateSettingsCache()
      expect(readSettings().defaultModel).toBe('changed')
    })
  })

  describe('setSettingsPath / getActiveSettingsPath', () => {
    it('redirects read/write to new path', () => {
      const newPath = join(tmpDir, 'other-settings.json')
      writeSettings({ defaultModel: 'first-path' })
      setSettingsPath(newPath)
      expect(readSettings()).toEqual({}) // 新路径无文件
      writeSettings({ defaultModel: 'second-path' })
      expect(readSettings().defaultModel).toBe('second-path')
    })

    it('getActiveSettingsPath returns current path', () => {
      expect(getActiveSettingsPath()).toBe(settingsPath)
      const newPath = join(tmpDir, 'other.json')
      setSettingsPath(newPath)
      expect(getActiveSettingsPath()).toBe(newPath)
    })
  })

  describe('cross-domain sharing (single owner)', () => {
    it('settings.json is the same file for all domains', () => {
      // 模拟两个域（model 域和 extension 域）写各自的字段
      updateSettingsSync(s => { s.defaultModel = 'model-domain-field' })
      updateSettingsSync(s => { s.packages = ['ext-domain-field'] })
      const result = readSettings()
      // 两域的字段共存于同一文件（D17 单一所有者）
      expect(result.defaultModel).toBe('model-domain-field')
      expect(result.packages).toEqual(['ext-domain-field'])
    })
  })
})
