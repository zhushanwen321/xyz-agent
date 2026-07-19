import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { persistSessionEnd, extractSessionOutcome } from '../infra/pi/session-file-utils.js'

describe('session-file-utils sidecar', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'test-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('U1: persistSessionEnd writes .meta.json sidecar', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n')
    persistSessionEnd(filePath, 'done')
    expect(existsSync(filePath + '.meta.json')).toBe(true)
    const meta = JSON.parse(readFileSync(filePath + '.meta.json', 'utf-8'))
    expect(meta.outcome).toBe('done')
    expect(meta.type).toBe('session_end')
    // JSONL should NOT have session_end
    const content = readFileSync(filePath, 'utf-8')
    expect(content).not.toContain('session_end')
  })

  it('U2: extractSessionOutcome reads sidecar first', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n')
    // Write sidecar
    writeFileSync(filePath + '.meta.json', JSON.stringify({ type: 'session_end', outcome: 'error', timestamp: new Date().toISOString() }))
    expect(extractSessionOutcome(filePath)).toBe('error')
  })

  it('U2b: extractSessionOutcome fallback to JSONL when no sidecar', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n{"type":"session_end","outcome":"stopped","timestamp":"2026-01-01"}\n')
    expect(extractSessionOutcome(filePath)).toBe('stopped')
  })

  it('U2c: extractSessionOutcome returns null when nothing', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n')
    expect(extractSessionOutcome(filePath)).toBeNull()
  })
})
