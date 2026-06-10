import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { patchSessionCwd } from '../src/session-file-utils.js'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
