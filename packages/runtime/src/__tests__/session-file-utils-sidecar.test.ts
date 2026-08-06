import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { persistSessionEnd, extractSessionOutcome, persistProjectBinding, readProjectBinding } from '../infra/pi/session-file-utils.js'

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

  // ── project binding sidecar（D14 语义修正 2026-08-04）──
  it('P1: persistProjectBinding writes .project.json sidecar', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n')
    persistProjectBinding(filePath, 'proj-abc')
    expect(existsSync(filePath + '.project.json')).toBe(true)
    const binding = JSON.parse(readFileSync(filePath + '.project.json', 'utf-8'))
    expect(binding.projectId).toBe('proj-abc')
    expect(binding.version).toBe(1)
  })

  it('P2: readProjectBinding reads back persisted id', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n')
    persistProjectBinding(filePath, 'proj-abc')
    expect(readProjectBinding(filePath)).toBe('proj-abc')
  })

  it('P3: readProjectBinding returns undefined when no sidecar / corrupted', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n')
    expect(readProjectBinding(filePath)).toBeUndefined()
    // 损坏 sidecar（非字符串 projectId）→ undefined
    writeFileSync(filePath + '.project.json', '{"projectId":123}')
    expect(readProjectBinding(filePath)).toBeUndefined()
  })

  it('P4: persistProjectBinding skips when JSONL missing（规则 #6 延迟写入窗口）', () => {
    const filePath = join(dir, 'never-flushed.jsonl')
    persistProjectBinding(filePath, 'proj-abc')
    expect(existsSync(filePath + '.project.json')).toBe(false)
  })

  it('P5: persistProjectBinding skips empty projectId（归回默认项目 = 删除绑定）', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n')
    persistProjectBinding(filePath, '')
    expect(existsSync(filePath + '.project.json')).toBe(false)
  })
})
