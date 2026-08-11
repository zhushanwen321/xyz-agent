import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { handleSessionRead } from '../tool-handler.js'

/**
 * M3 tool-handler 集成测试。
 *
 * 测试框架 vitest（禁止 node:test/tsx）。直接调 handleSessionRead（纯逻辑，agentDir 注入），
 * 传真实 `/Users/zhushanwen/.pi/agent` 作 agentDir——用本机真实历史 session 数据，无需 mock。
 *
 * 覆盖 7 action 主路径 + F1(find 零匹配)/F4(turn 越界)/F5(缺参)/resolveSessionId 片段等价。
 */

/** 真实 pi agent 目录（本机），含充足历史 session。 */
const REAL = '/Users/zhushanwen/.pi/agent'
/** 5.4MB / 32 turn / 1204 entry 的真实 session（feat-plugin-arch-3 目录）。 */
const E6 = '019e6c96-0a0c-74b8-a73f-d1854d88e2a7'
/** 真实 fork 家族根（fork 子代 019fe632，隔代 subagent 019fe635 挂在 019fe632 下）。 */
const FAM = '019fe620-8ae1-78a7-b76a-43a1ba4cc3c7'

describe('handleSessionRead', () => {
  it('1. find by uuid fragment returns matching session', async () => {
    const r = await handleSessionRead({ action: 'find', query: 'e6c96' }, REAL)
    const d = r.details as { matches: Array<{ sessionId: string }> }
    expect(d.matches.some((m) => m.sessionId.startsWith('019e6c96'))).toBe(true)
    expect(r.content[0]).toEqual({ type: 'text', text: expect.any(String) })
  })

  it('2. outline yields 32 turns within token budget (v2 O1: <=1500)', async () => {
    const r = await handleSessionRead({ action: 'outline', session: E6 }, REAL)
    const d = r.details as { turns: unknown[]; tokenEstimate: number }
    expect(d.turns.length).toBe(32)
    // v2 O1：加 assistantBrief + 修 toolSummary bug 后阈值 600→1500（design §3.3 D4）
    expect(d.tokenEstimate).toBeLessThanOrEqual(1500)
  })

  it('3. detail single turn returns toolResult summary by default (v2 O3)', async () => {
    const r = await handleSessionRead({ action: 'detail', session: E6, turns: 'T001' }, REAL)
    const d = r.details as { entries: Array<{ type: string; message?: { role?: string } }> }
    expect(d.entries.length).toBeGreaterThan(0)
    // v2 O3：默认 toolResult 变摘要态（type=toolResultSummary），条目不消失
    expect(d.entries.some((e) => e.type === 'toolResultSummary')).toBe(true)
    // 不再有 role=toolResult 的原文 entry（除非 includeToolResult:true）
    expect(d.entries.some((e) => e.message?.role === 'toolResult')).toBe(false)
  })

  it('4. family lists fork children and隔代 subagents', async () => {
    const r = await handleSessionRead({ action: 'family', session: FAM }, REAL)
    const d = r.details as {
      forks: Array<{ sessionId: string }>
      subagents: Array<{ sessionId: string }>
    }
    expect(d.forks.some((f) => f.sessionId.startsWith('019fe632'))).toBe(true)
    // 隔代：019fe635.rootSessionId=019fe632（fork 子代），从家族根 FAM 出发仍能关联
    expect(d.subagents.some((s) => s.sessionId.startsWith('019fe635'))).toBe(true)
  })

  it('5. search pattern returns hits', async () => {
    const r = await handleSessionRead({ action: 'search', session: E6, pattern: 'plugin' }, REAL)
    const d = r.details as { hits: Array<{ turnIndex: number; matchSnippet: string }> }
    expect(d.hits.length).toBeGreaterThan(0)
    expect(typeof d.hits[0].matchSnippet).toBe('string')
  })

  it('6. export outline materializes a .md file', async () => {
    const r = await handleSessionRead(
      { action: 'export', session: E6, format: 'outline' },
      REAL,
    )
    const d = r.details as { path: string; sizeBytes: number }
    expect(d.path).toMatch(/\.md$/)
    expect(existsSync(d.path)).toBe(true)
    expect(d.sizeBytes).toBeGreaterThan(0)
  })

  it('7. F1 find zero match returns empty matches + 👉 hint (no throw)', async () => {
    const r = await handleSessionRead({ action: 'find', query: 'zzz999' }, REAL)
    const d = r.details as { matches: unknown[]; truncated: boolean }
    expect(d.matches).toEqual([])
    expect(d.truncated).toBe(false)
    expect(r.content[0].text).toContain('👉')
  })

  it('8. F4 detail turn out of range throws with 越界', async () => {
    await expect(
      handleSessionRead({ action: 'detail', session: E6, turns: 'T999' }, REAL),
    ).rejects.toThrow(/越界/)
  })

  it('9. F5 outline missing session throws naming session', async () => {
    await expect(handleSessionRead({ action: 'outline' }, REAL)).rejects.toThrow(/session/)
  })

  it('10. resolveSessionId fragment equivalent to full id', async () => {
    const rFull = await handleSessionRead({ action: 'outline', session: E6 }, REAL)
    const rFrag = await handleSessionRead({ action: 'outline', session: 'e6c96' }, REAL)
    const dFull = rFull.details as { turns: unknown[] }
    const dFrag = rFrag.details as { turns: unknown[] }
    expect(dFrag.turns.length).toBe(dFull.turns.length)
  })
})
