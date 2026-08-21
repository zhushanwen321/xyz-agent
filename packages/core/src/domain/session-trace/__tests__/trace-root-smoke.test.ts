import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { computeTraceContextBoundary } from '../context-boundary'
import { parseSessionTraceJsonl } from '../parse-jsonl'
import { filterTraceRows } from '../trace-filter'
import { mapSessionTraceRows } from '../trace-rows'

const FIXTURES = new URL('../__fixtures__/', import.meta.url)
const SCRIPTS = new URL('../../../../../../scripts/cw/', import.meta.url)

/**
 * R0: 根 unit session-trace 的机器验收抽查锚（vitest nameMatch 须含 "R0"）。
 * 两部分断言：
 * 1. 跨模块烟雾：parse → row 映射 → 边界计算 → 过滤在真实 fixture 上走通（深度覆盖归 A 系列）。
 * 2. 根 gate 脚本标记行契约：e2e-sh MARKER_RE 行尾锚定（`^<id> (PASS|FAIL)$`），
 *    stdout 不允许括号后缀——本次修复的内容，旧脚本行为下本断言失败（红阶段区分力来源）。
 */
describe('R0 session-trace root smoke', () => {
  it('parse→rows→boundary→filter 全链在真实 fixture 上走通', () => {
    const text = readFileSync(new URL('real-mixed-kinds.jsonl', FIXTURES), 'utf-8')
    const lines = parseSessionTraceJsonl(text)
    const entries = lines.flatMap((l) => (l.ok ? [l.entry] : []))
    expect(entries.length).toBeGreaterThan(50)
    const rows = mapSessionTraceRows({ lines })
    expect(rows.length).toBeGreaterThan(0)
    const boundary = computeTraceContextBoundary(entries)
    expect(boundary.contextEntryIds.size + boundary.shadowedEntryIds.size).toBeGreaterThan(0)
    const visible = filterTraceRows(rows, { contextOnly: true })
    expect(visible.length).toBeGreaterThan(0)
    for (const r of visible) {
      const id = r.entry.id
      if (id) expect(boundary.shadowedEntryIds.has(id)).toBe(false)
    }
  })

  it('根 gate 脚本 stdout 满足 e2e-sh 标记行契约', { timeout: 90_000 }, () => {
    const markerRe = /^(R[012]) (PASS|FAIL)$/
    for (const script of ['trace-root-gate.sh']) {
      const res = spawnSync('bash', [new URL(script, SCRIPTS).pathname], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60_000,
        encoding: 'utf-8',
      })
      // gate 当前红相（R2 手工未勾）退出码非零属预期，只断言 stdout 标记行契约
      expect(res.signal ?? null).toBeNull() // spawnSync 未被超时 SIGTERM
      const lines = (res.stdout ?? '').split('\n').filter((l) => l.trim() !== '')
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).toMatch(markerRe)
    }
  })
})
