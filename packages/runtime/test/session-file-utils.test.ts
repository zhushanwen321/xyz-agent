import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { patchSessionCwd, persistSessionName } from '../src/infra/pi/session-file-utils.js'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('persistSessionName', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sfu-persist-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * U1: 文件不存在时不再创建文件（规则 #6 EEXIST 防护）。
   *
   * 原实现用 openSync(wx) 提前建文件，与 pi 0.80.3 _persist 的 openSync(wx) 冲突 →
   * EEXIST → session 永久卡死（同文件第 60-65 行 [HISTORICAL] 注释记录的事故）。
   * 修复后文件不存在时只 console.warn + return，绝不创建文件。
   */
  it('文件不存在时不再创建文件（规则#6 EEXIST 防护）', () => {
    const filePath = join(tmpDir, 'nonexistent.jsonl')
    expect(() =>
      persistSessionName(filePath, 'test-name', 'session-id', '/cwd'),
    ).not.toThrow()
    // 核心断言：文件未被创建
    expect(existsSync(filePath)).toBe(false)
  })

  /**
   * U2: 文件已存在时正常 append session_info（不回归）。
   * 确保删掉 wx 建文件分支后，append 分支仍正常工作。
   */
  it('文件已存在时正常 append session_info（不回归）', () => {
    const filePath = join(tmpDir, 'existing.jsonl')
    const header = JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2025-01-01T00:00:00Z', cwd: '/proj' })
    writeFileSync(filePath, header + '\n', 'utf-8')

    persistSessionName(filePath, 'new-name')

    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    // 原有 header 保留
    expect(JSON.parse(lines[0]).type).toBe('session')
    // 最后一行是新增的 session_info
    const lastEntry = JSON.parse(lines[lines.length - 1])
    expect(lastEntry.type).toBe('session_info')
    expect(lastEntry.name).toBe('new-name')
  })
})

describe('patchSessionCwd', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sfu-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeSessionFile(headerOverrides: Record<string, unknown> = {}): string {
    const header = { type: 'session', version: 3, id: 'test-id', cwd: '/old/cwd', timestamp: '2025-01-01T00:00:00Z', ...headerOverrides }
    const path = join(tmpDir, 'test-session.jsonl')
    const entries = [JSON.stringify(header), JSON.stringify({ type: 'user', content: 'hello' })]
    writeFileSync(path, entries.join('\n'), 'utf-8')
    return path
  }

  it('patches cwd in session header', () => {
    const fp = makeSessionFile()
    const result = patchSessionCwd(fp, '/new/cwd')
    expect(result).toBe(true)

    const lines = readFileSync(fp, 'utf-8').split('\n')
    const header = JSON.parse(lines[0])
    expect(header.cwd).toBe('/new/cwd')
  })

  it('preserves other header fields and entries', () => {
    const fp = makeSessionFile({ extraField: 'kept' })
    patchSessionCwd(fp, '/new/cwd')

    const lines = readFileSync(fp, 'utf-8').split('\n')
    const header = JSON.parse(lines[0])
    expect(header.extraField).toBe('kept')
    expect(header.id).toBe('test-id')
    // second entry preserved
    const second = JSON.parse(lines[1])
    expect(second.type).toBe('user')
  })

  it('returns false for empty file', () => {
    const fp = join(tmpDir, 'empty.jsonl')
    writeFileSync(fp, '', 'utf-8')
    expect(patchSessionCwd(fp, '/new/cwd')).toBe(false)
  })

  it('returns false for non-session header type', () => {
    const fp = join(tmpDir, 'non-session.jsonl')
    writeFileSync(fp, JSON.stringify({ type: 'other', cwd: '/old' }), 'utf-8')
    expect(patchSessionCwd(fp, '/new/cwd')).toBe(false)
  })

  it('returns false for malformed JSON on first line', () => {
    const fp = join(tmpDir, 'bad.jsonl')
    writeFileSync(fp, 'not-json\nmore', 'utf-8')
    expect(patchSessionCwd(fp, '/new/cwd')).toBe(false)
  })

  it('returns false for non-existent file', () => {
    const fp = join(tmpDir, 'missing.jsonl')
    expect(patchSessionCwd(fp, '/new/cwd')).toBe(false)
  })

  it('leaves no leftover tmp files on success', () => {
    const fp = makeSessionFile()
    patchSessionCwd(fp, '/new/cwd')

    const remaining = readdirSync(tmpDir).filter(f => f.includes('.patch-tmp'))
    expect(remaining).toHaveLength(0)
  })
})
