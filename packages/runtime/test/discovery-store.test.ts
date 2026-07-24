import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  readDiscovery,
  writeDiscovery,
  getSkillDirs,
  getAgentDirs,
  getExtensionDirs,
  setSkillDirs,
  setAgentDirs,
  setExtensionDirs,
  setDiscoveryPath,
  invalidateDiscoveryCache,
} from '../src/infra/pi/discovery-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string
let discoveryPath: string

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'discovery-store-test-'))
  discoveryPath = join(tmpDir, 'discovery.json')
  setDiscoveryPath(discoveryPath)
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})

describe('discovery-store', () => {
  describe('readDiscovery', () => {
    it('returns default empty config when file does not exist', () => {
      expect(readDiscovery()).toEqual({ version: 1, skillDirs: [], agentDirs: [], extensionDirs: [] })
    })

    it('reads existing skillDirs/agentDirs', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['~/.pi/agent/skills', '~/.claude/skills'],
        agentDirs: ['~/.agents/agents'],
      }), 'utf-8')
      expect(getSkillDirs()).toEqual(['~/.pi/agent/skills', '~/.claude/skills'])
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
    })

    it('returns default on corrupt JSON', () => {
      writeFileSync(discoveryPath, '{ broken', 'utf-8')
      expect(readDiscovery()).toEqual({ version: 1, skillDirs: [], agentDirs: [], extensionDirs: [] })
    })

    it('returns default on non-object JSON (e.g. array)', () => {
      writeFileSync(discoveryPath, '[1,2,3]', 'utf-8')
      expect(readDiscovery()).toEqual({ version: 1, skillDirs: [], agentDirs: [], extensionDirs: [] })
    })

    it('filters non-string entries in skillDirs/agentDirs', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['ok', 123, null, 'also-ok'],
        agentDirs: [true, 'agent-ok'],
      }), 'utf-8')
      expect(getSkillDirs()).toEqual(['ok', 'also-ok'])
      expect(getAgentDirs()).toEqual(['agent-ok'])
    })

    it('preserves array order (priority: earlier overrides later)', () => {
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['~/.pi/agent/skills', '~/.claude/skills', '.agents/skills'],
        agentDirs: [],
      }), 'utf-8')
      expect(getSkillDirs()).toEqual(['~/.pi/agent/skills', '~/.claude/skills', '.agents/skills'])
    })
  })

  describe('setSkillDirs / setAgentDirs', () => {
    it('writes skillDirs and preserves existing agentDirs', () => {
      setSkillDirs(['~/.pi/agent/skills', '~/.claude/skills'])
      setAgentDirs(['~/.agents/agents'])
      expect(getSkillDirs()).toEqual(['~/.pi/agent/skills', '~/.claude/skills'])
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
    })

    it('overwrites skillDirs in order (drag-to-reorder writes new array)', () => {
      setSkillDirs(['a', 'b', 'c'])
      // 模拟拖拽把 c 提到最前
      setSkillDirs(['c', 'a', 'b'])
      expect(getSkillDirs()).toEqual(['c', 'a', 'b'])
    })

    it('persists to disk (re-read via fresh cache after invalidate)', () => {
      setSkillDirs(['~/.pi/agent/skills'])
      invalidateDiscoveryCache()
      const onDisk = JSON.parse(readFileSync(discoveryPath, 'utf-8'))
      expect(onDisk.skillDirs).toEqual(['~/.pi/agent/skills'])
      expect(onDisk.version).toBe(1)
    })

    it('deletes file when skillDirs and agentDirs and extensionDirs empty', () => {
      setSkillDirs(['~/.pi/agent/skills'])
      expect(existsSync(discoveryPath)).toBe(true)
      // 清空 → 空则删（与 disabled-packages.json 语义一致）
      setSkillDirs([])
      setAgentDirs([])
      expect(existsSync(discoveryPath)).toBe(false)
      // 再读返回默认，不崩
      expect(readDiscovery()).toEqual({ version: 1, skillDirs: [], agentDirs: [], extensionDirs: [] })
    })
  })

  describe('setExtensionDirs', () => {
    it('writes extensionDirs and preserves existing skillDirs/agentDirs', () => {
      setSkillDirs(['~/.pi/agent/skills'])
      setAgentDirs(['~/.agents/agents'])
      setExtensionDirs(['~/.pi/agent/extensions'])
      expect(getExtensionDirs()).toEqual(['~/.pi/agent/extensions'])
      // 不影响其他数组
      expect(getSkillDirs()).toEqual(['~/.pi/agent/skills'])
      expect(getAgentDirs()).toEqual(['~/.agents/agents'])
    })

    it('does not delete file when only extensionDirs is non-empty', () => {
      setSkillDirs(['~/.pi/agent/skills'])
      setSkillDirs([])
      setAgentDirs([])
      setExtensionDirs(['~/.pi/agent/extensions'])
      // extensionDirs 非空 → 文件保留
      expect(existsSync(discoveryPath)).toBe(true)
      expect(getExtensionDirs()).toEqual(['~/.pi/agent/extensions'])
      // 清空 extensionDirs 后三者皆空 → 删文件
      setExtensionDirs([])
      expect(existsSync(discoveryPath)).toBe(false)
    })
  })

  describe('writeDiscovery (full overwrite)', () => {
    it('writes full config object', () => {
      writeDiscovery({ version: 1, skillDirs: ['x'], agentDirs: ['y'], extensionDirs: ['z'] })
      expect(readDiscovery()).toEqual({ version: 1, skillDirs: ['x'], agentDirs: ['y'], extensionDirs: ['z'] })
    })
  })

  describe('TTL cache', () => {
    it('serves cached value within TTL, ignores external file change', () => {
      setSkillDirs(['v1'])
      // 外部直接改盘，绕过 store
      writeFileSync(discoveryPath, JSON.stringify({
        version: 1,
        skillDirs: ['v2-external'],
        agentDirs: [],
      }), 'utf-8')
      // TTL 缓存挡住外部改动
      expect(getSkillDirs()).toEqual(['v1'])
      // invalidate 后才看到外部改动
      invalidateDiscoveryCache()
      expect(getSkillDirs()).toEqual(['v2-external'])
    })
  })
})
