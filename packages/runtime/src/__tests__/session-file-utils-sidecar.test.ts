import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { persistSessionEnd, extractSessionOutcome, persistProjectBinding, readProjectBinding, parseSessionHeader } from '../infra/pi/session-file-utils.js'

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

  it('P6: 归回默认项目（空 projectId）删除已存在的绑定 sidecar（review MF-2 回归防护）', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n')
    // 先绑定命名项目 → sidecar 存在且可读回
    persistProjectBinding(filePath, 'proj-abc')
    expect(readProjectBinding(filePath)).toBe('proj-abc')
    // 归回默认 → 空 projectId 必须删除 sidecar，读取侧兑底 undefined
    persistProjectBinding(filePath, '')
    expect(existsSync(filePath + '.project.json')).toBe(false)
    expect(readProjectBinding(filePath)).toBeUndefined()
  })

  it('P7: 归回默认项目且 JSONL 缺失（延迟写入窗口）仍删除已存在 sidecar（删除不依赖 JSONL）', () => {
    const filePath = join(dir, 'test.jsonl')
    writeFileSync(filePath, '{"type":"message","id":"m1"}\n')
    persistProjectBinding(filePath, 'proj-abc')
    // 模拟 JSONL 被移除（如重建），sidecar 残留
    rmSync(filePath)
    persistProjectBinding(filePath, '')
    expect(existsSync(filePath + '.project.json')).toBe(false)
  })

  // ── parseSessionHeader 首行读（wave:perf-w20 微项 9）──
  // 只读文件头部 4KB 而非全量 readFileSync，行为与旧实现等价：多行大文件只取首行 header。
  it('H1: parseSessionHeader 多行长文件只读首行——header 解析正确且不触碰后续行', () => {
    const filePath = join(dir, 'long.jsonl')
    const header = JSON.stringify({ type: 'session', id: 'sess-h1', cwd: '/test', timestamp: '2026-08-16T00:00:00.000Z', parentSession: '/old.jsonl', forkEntryId: 'e-9' })
    // 首行 header + 大量后续 entry（超过 4KB 读块，验证只取首行不受影响）
    const tail = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'message', id: `m-${i}`, content: 'x'.repeat(80) })).join('\n')
    writeFileSync(filePath, `${header}\n${tail}\n`)
    const parsed = parseSessionHeader(filePath)
    expect(parsed).toEqual({
      id: 'sess-h1', cwd: '/test', timestamp: '2026-08-16T00:00:00.000Z',
      parentSession: '/old.jsonl', forkEntryId: 'e-9',
    })
  })

  it('H2: parseSessionHeader 首行非 session 类型 / 空文件 / 不存在文件 → null', () => {
    const notSession = join(dir, 'not-session.jsonl')
    writeFileSync(notSession, '{"type":"message","id":"m1"}\n')
    expect(parseSessionHeader(notSession)).toBeNull()

    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '')
    expect(parseSessionHeader(empty)).toBeNull()

    expect(parseSessionHeader(join(dir, 'missing.jsonl'))).toBeNull()
  })

  it('H3: parseSessionHeader 无换行单行文件（首行即全内容）仍可解析', () => {
    const filePath = join(dir, 'single-line.jsonl')
    writeFileSync(filePath, JSON.stringify({ type: 'session', id: 'sess-h3', cwd: '/x', timestamp: 't' }))
    expect(parseSessionHeader(filePath)?.id).toBe('sess-h3')
  })

  // W20 review Fix-4：首行 > 4KB（读块满仍无换行）→ 回退全量读首行，与旧 readFileSync
  // 全量读实现严格等价——单纯截断会让超长首行 JSON.parse 失败 → session 从侧栏消失。
  it('H4: parseSessionHeader 首行超 4KB 无换行 → 回退全量读，header 仍正确解析', () => {
    const filePath = join(dir, 'huge-first-line.jsonl')
    // 构造 > 4KB 的合法 session header（超长 cwd 字段填充），无换行（单行文件）
    const header = JSON.stringify({
      type: 'session',
      id: 'sess-h4',
      cwd: '/x'.repeat(8192),
      timestamp: '2026-08-16T00:00:00.000Z',
    })
    expect(header.length).toBeGreaterThan(4096)
    writeFileSync(filePath, header)
    const parsed = parseSessionHeader(filePath)
    expect(parsed?.id).toBe('sess-h4')
    expect(parsed?.cwd).toBe('/x'.repeat(8192))
  })
})
