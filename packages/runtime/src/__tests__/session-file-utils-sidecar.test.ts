/**
 * Agent binding sidecar 测试（u7-sidecar-persist 验收 A3 + A4）。
 *
 * A3：规则 #6 守卫——session JSONL 不存在时 persistAgentBinding 不创建 sidecar。
 * A3b：缓存失效集成——persistAgentBinding 写入后 sessionMetaCache 失效，scanPiSessions 能立即读到 binding。
 * A4：readAgentBinding 降级路径——sidecar 不存在/JSON 损坏/spawnSource 非法 → undefined。
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  persistAgentBinding,
  readAgentBinding,
  agentSidecarPath,
  scanPiSessions,
  invalidateScanDirCache,
  _resetSessionMetaCacheForTest,
} from '../infra/pi/session-file-utils.js'

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('persistAgentBinding', () => {
  it('A3: 规则 #6 守卫——session JSONL 不存在时不创建 sidecar', () => {
    const dir = makeTmpDir('u7-a3-')
    try {
      const nonExistentFile = join(dir, 'nonexistent.jsonl')
      // 确保文件确实不存在
      expect(existsSync(nonExistentFile)).toBe(false)

      // 记录 sidecar 目录下的文件数量（应为 0）
      const sidecarPath = agentSidecarPath(nonExistentFile)
      const sidecarDir = join(dir, 'sidecar-check')
      mkdirSync(sidecarDir, { recursive: true })
      const filesBefore = existsSync(sidecarPath) ? 1 : 0

      // 调用 persistAgentBinding，文件不存在应静默跳过
      persistAgentBinding(nonExistentFile, 'agent', 'parent-123')

      // 验证 sidecar 未被创建
      const filesAfter = existsSync(sidecarPath) ? 1 : 0
      expect(filesAfter).toBe(filesBefore)
      expect(existsSync(sidecarPath)).toBe(false)

      // 验证 sidecar 目录下没有新增文件（确保没有创建其他文件）
      const { readdirSync } = require('node:fs')
      const sidecarFiles = readdirSync(dir).filter((f: string) => f.includes('.agent.json'))
      expect(sidecarFiles.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A1-positive: 文件存在时 sidecar 被正确创建且 readAgentBinding 回读一致（正向对照）', () => {
    const dir = makeTmpDir('u7-a1-pos-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 确保 sidecar 不存在
      const sidecarPath = agentSidecarPath(fp)
      expect(existsSync(sidecarPath)).toBe(false)

      // 调用 persistAgentBinding，文件存在应创建 sidecar
      persistAgentBinding(fp, 'agent', 'parent-123')

      // 验证 sidecar 被创建
      expect(existsSync(sidecarPath)).toBe(true)

      // 验证 sidecar 内容
      const { readFileSync } = require('node:fs')
      const data = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
      expect(data.spawnSource).toBe('agent')
      expect(data.parentAgentSessionId).toBe('parent-123')
      expect(data.version).toBe(1)

      // readAgentBinding 回读验证
      const result = readAgentBinding(fp)
      expect(result).toBeDefined()
      expect(result!.spawnSource).toBe('agent')
      expect(result!.parentAgentSessionId).toBe('parent-123')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('A3b: 缓存失效集成', () => {
  it('A2: scanSessionMeta 合并 agent binding——persistAgentBinding 写入后 sessionMetaCache 失效，scanPiSessions({ force: false }) 能立即读到 binding', () => {
    const dir = makeTmpDir('u7-a3b-')
    try {
      // 设置临时数据目录
      const origDataDir = process.env.XYZ_AGENT_DATA_DIR
      process.env.XYZ_AGENT_DATA_DIR = dir

      // 重置缓存
      _resetSessionMetaCacheForTest()
      invalidateScanDirCache()

      // 创建 session 文件
      const sessionsDir = join(dir, 'pi', 'sessions')
      mkdirSync(sessionsDir, { recursive: true })
      const fp = join(sessionsDir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 先扫描一次，填充缓存
      let sessions = scanPiSessions({ force: true })
      expect(sessions.length).toBe(1)
      expect(sessions[0].spawnSource).toBeUndefined()

      // 写入 agent binding
      persistAgentBinding(fp, 'agent', 'parent-123')

      // 再次扫描（force:false 走正常缓存路径），应该能读到 binding（缓存已失效）
      sessions = scanPiSessions({ force: false })
      expect(sessions.length).toBe(1)
      expect(sessions[0].spawnSource).toBe('agent')
      expect(sessions[0].parentAgentSessionId).toBe('parent-123')

      // 恢复环境变量
      if (origDataDir !== undefined) {
        process.env.XYZ_AGENT_DATA_DIR = origDataDir
      } else {
        delete process.env.XYZ_AGENT_DATA_DIR
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readAgentBinding', () => {
  it('A4 case1: sidecar 不存在返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-1-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 无 sidecar 文件
      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A4 case2: JSON 损坏返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-2-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 写入损坏的 JSON
      const sidecarPath = agentSidecarPath(fp)
      writeFileSync(sidecarPath, 'not valid json {{{')

      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A4 case3: spawnSource 非法返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-3-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 写入 spawnSource 非字符串的 sidecar
      const sidecarPath = agentSidecarPath(fp)
      writeFileSync(sidecarPath, JSON.stringify({ spawnSource: 123, parentAgentSessionId: 'parent-123', version: 1 }))

      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A4 case4: parentAgentSessionId 非法返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-4-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 写入 parentAgentSessionId 非字符串的 sidecar
      const sidecarPath = agentSidecarPath(fp)
      writeFileSync(sidecarPath, JSON.stringify({ spawnSource: 'agent', parentAgentSessionId: null, version: 1 }))

      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
