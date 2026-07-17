/**
 * W4/W5: persistSessionEnd + extractSessionOutcome round-trip + existsSync guard。
 *
 * 覆盖：
 * - AC-3：persistSessionEnd 写入后 extractSessionOutcome 能正确读出 done/error/stopped
 * - AC-7：persistSessionEnd 在文件不存在时不创建文件、不抛（规则 #6 pi _persist 竞态保护）
 * - AC-4：scanner 能从 session_end 派生终态（无 session_end 回退 idle）
 *
 * 运行：cd packages/runtime && npx vitest run test/session-end-entry.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistSessionEnd, extractSessionOutcome, type SessionOutcome } from '../src/infra/pi/session-file-utils.js'

describe('W4: persistSessionEnd + extractSessionOutcome round-trip（AC-3）', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-session-end-'))
    filePath = join(dir, 'test.jsonl')
    // 模拟 pi 已 flush 的 session 文件（首行 session header）
    writeFileSync(filePath, JSON.stringify({ type: 'session', id: 's1', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persistSessionEnd(done) 后 extractSessionOutcome 返回 done', () => {
    persistSessionEnd(filePath, 'done')
    expect(extractSessionOutcome(filePath)).toBe('done')
  })

  it('persistSessionEnd(error) 后 extractSessionOutcome 返回 error', () => {
    persistSessionEnd(filePath, 'error', 'Connection failed')
    expect(extractSessionOutcome(filePath)).toBe('error')
  })

  it('persistSessionEnd(stopped) 后 extractSessionOutcome 返回 stopped', () => {
    persistSessionEnd(filePath, 'stopped')
    expect(extractSessionOutcome(filePath)).toBe('stopped')
  })

  it('写入的 entry 含 type=session_end + outcome + timestamp', () => {
    persistSessionEnd(filePath, 'done')
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    const lastLine = lines[lines.length - 1]
    const entry = JSON.parse(lastLine)
    expect(entry.type).toBe('session_end')
    expect(entry.outcome).toBe('done')
    expect(entry.timestamp).toBeTruthy()
  })

  it('无 session_end 的文件 → extractSessionOutcome 返回 null（AC-4 回退）', () => {
    expect(extractSessionOutcome(filePath)).toBeNull()
  })

  it('append 不覆盖已有内容（session_end 在文件尾部）', () => {
    // 先写几条消息
    writeFileSync(filePath, JSON.stringify({ type: 'session', id: 's1', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n'
      + JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:01.000Z' }) + '\n')
    persistSessionEnd(filePath, 'done')
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[2]).type).toBe('session_end')
    // 前两条完好
    expect(JSON.parse(lines[0]).type).toBe('session')
    expect(JSON.parse(lines[1]).type).toBe('message')
  })
})

describe('W4: persistSessionEnd existsSync guard（AC-7 规则 #6）', () => {
  it('文件不存在时不创建文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-no-file-'))
    const nonExist = join(dir, 'never-existed.jsonl')
    try {
      expect(existsSync(nonExist)).toBe(false)
      persistSessionEnd(nonExist, 'done')
      // 关键断言：文件仍未被创建（不违反规则 #6 pi _persist openSync(wx) 竞态）
      expect(existsSync(nonExist)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件不存在时不抛异常', () => {
    const nonExist = join(mkdtempSync(join(tmpdir(), 'cw-no-throw-')), 'no.jsonl')
    expect(() => persistSessionEnd(nonExist, 'done')).not.toThrow()
  })

  it('空路径直接 return 不抛', () => {
    expect(() => persistSessionEnd('', 'done')).not.toThrow()
  })
})

describe('W4: SessionOutcome 类型完整性', () => {
  it('三种 outcome 值可被 extractSessionOutcome 正确区分', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-types-'))
    try {
      const outcomes: SessionOutcome[] = ['done', 'error', 'stopped']
      for (const o of outcomes) {
        const fp = join(dir, `${o}.jsonl`)
        writeFileSync(fp, JSON.stringify({ type: 'session', id: 's', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n')
        persistSessionEnd(fp, o)
        expect(extractSessionOutcome(fp)).toBe(o)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
