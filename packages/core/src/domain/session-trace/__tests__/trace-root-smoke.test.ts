import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeTraceContextBoundary } from '../context-boundary'
import { parseSessionTraceJsonl } from '../parse-jsonl'
import { filterTraceRows } from '../trace-filter'
import { mapSessionTraceRows } from '../trace-rows'

const FIXTURES = new URL('../__fixtures__/', import.meta.url)

/**
 * R0: 根 unit session-trace 的机器验收抽查锚（vitest nameMatch 须含 "R0"）。
 * 深度覆盖归各子单元的 A 系列套件，此处只做跨模块烟雾断言：
 * parse → row 映射 → 边界计算 → 过滤 四模块在真实 fixture 上可完整走通。
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
})
