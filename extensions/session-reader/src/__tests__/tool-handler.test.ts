import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSessionRead, renderExtractItems, type SessionReadParams } from '../tool-handler.js'
import { REAL_AGENT_DIR as REAL, E6, FAM, HAS_E6, HAS_REAL } from './real-data.js'

/**
 * M3 tool-handler 集成测试。
 *
 * 测试框架 vitest（禁止 node:test/tsx）。直接调 handleSessionRead（纯逻辑，agentDir 注入），
 * 传真实 `/Users/zhushanwen/.pi/agent` 作 agentDir——用本机真实历史 session 数据，无需 mock。
 *
 * 覆盖 7 action 主路径 + F1(find 零匹配)/F4(turn 越界)/F5(缺参)/resolveSessionId 片段等价。
 *
 * 真实数据用例全部带 skipIf 守卫（CI 无本机 ~/.pi/agent → skip，不硬失败）；
 * renderExtractItems F9 截断是纯 fixture，无条件跑。
 */

describe.skipIf(!HAS_REAL)('handleSessionRead', () => {
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

  // w1 合并 subagent 候选后两处影响（design R2 盲点连带修复）：
  // 1) query：'zzz999' 在本机某 subagent 首消息命中 → 换确定零匹配串
  // 2) timeout：缺省 find 全扫 main+subagent 真实数据 ~8s，默认 5s 卡边界 → 放宽到 30s
  //    （w2 实现 handler source 透传后可改 source:'main' 收窄到 main 侧，届时恢复默认 timeout）
  it('7. F1 find zero match returns empty matches + 👉 hint (no throw)', async () => {
    const r = await handleSessionRead({ action: 'find', query: 'zzz-nonexistent-session-9q8x2' }, REAL)
    const d = r.details as { matches: unknown[]; truncated: boolean }
    expect(d.matches).toEqual([])
    expect(d.truncated).toBe(false)
    expect(r.content[0].text).toContain('👉')
  }, 30000)

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

describe.skipIf(!HAS_E6)('extract (v2 O4)', () => {
  it('user-messages returns 26 user entries with turn + full text', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'user-messages' },
      REAL,
    )
    const d = r.details as {
      what: string
      count: number
      shown: number
      truncated: boolean
      items: Array<{ turn: number; text: string }>
    }
    expect(d.what).toBe('user-messages')
    expect(d.count).toBe(26) // 全量 user entry 数（design §1：26 user）
    // F9 预算可能截断：items 是 shown 子集，shown <= count
    expect(d.shown).toBeLessThanOrEqual(d.count)
    expect(d.items.length).toBe(d.shown)
    expect(d.items.length).toBeGreaterThan(0)
    expect(
      d.items.every((it) => typeof it.turn === 'number' && typeof it.text === 'string'),
    ).toBe(true)
  })

  it('commands (no filter) returns 519 tool calls with name + summary', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'commands' },
      REAL,
    )
    const d = r.details as {
      count: number
      shown: number
      items: Array<{ name: string; summary: string }>
    }
    expect(d.count).toBe(519) // 全量 toolCall（design §2.3：519）
    expect(d.shown).toBeLessThanOrEqual(d.count)
    expect(d.items.length).toBe(d.shown)
    expect(
      d.items.every((it) => typeof it.name === 'string' && typeof it.summary === 'string'),
    ).toBe(true)
    // 抽查 bash summary 含 "bash: "（D1 映射）
    const bashItem = d.items.find((it) => it.name === 'bash')
    if (bashItem !== undefined) {
      expect(bashItem.summary).toContain('bash: ')
    }
  })

  it('commands tool=bash returns 309 all bash', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'commands', tool: 'bash' },
      REAL,
    )
    const d = r.details as {
      count: number
      shown: number
      items: Array<{ name: string }>
    }
    expect(d.count).toBe(309) // bash toolCall 全量（F9 可能截断 shown 子集）
    expect(d.items.every((it) => it.name === 'bash')).toBe(true)
  })

  it('commands tool=nonexist triggers F8 with tool distribution (no throw)', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'commands', tool: 'nonexist' },
      REAL,
    )
    const d = r.details as {
      toolDistribution: Array<{ name: string; count: number }>
    }
    expect(r.content[0].text).toContain('无匹配')
    expect(r.content[0].text).toContain('bash×309')
    expect(r.content[0].text).toContain('👉')
    expect(d.toolDistribution.some((t) => t.name === 'bash' && t.count === 309)).toBe(true)
  })

  it('files returns deduped paths with op (read/edit/write/head)', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'files' },
      REAL,
    )
    const d = r.details as {
      count: number
      items: Array<{ path: string; basename: string; op: string; turns: number[] }>
    }
    expect(d.count).toBeGreaterThan(0) // 开发 session 有大量文件操作
    expect(d.items.length).toBeGreaterThan(0)
    // 抽查含 .ts 或 .md 文件
    expect(
      d.items.some((it) => it.path.endsWith('.ts') || it.path.endsWith('.md')),
    ).toBe(true)
    // op 含 read/edit/write/head 之一
    expect(d.items.some((it) => /read|edit|write|head/.test(it.op))).toBe(true)
    // turns 是数组（去重后出现过的轮次）
    expect(d.items.every((it) => Array.isArray(it.turns))).toBe(true)
  })

  it('commits returns hash list with 7-8 hex + source turn', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'commits' },
      REAL,
    )
    const d = r.details as {
      count: number
      items: Array<{ hash: string; turn: number; source: string; context: string }>
    }
    // 真实开发 session 有 git log/show 操作 → git-cmd 主路径应取到 hash
    expect(d.count).toBeGreaterThan(0)
    // commits 已知会误匹配/漏报（D6），只验每条格式
    for (const it of d.items) {
      expect(it.hash).toMatch(/^[0-9a-f]{7,8}$/)
      expect(typeof it.turn).toBe('number')
      expect(['git-cmd', 'commit-context']).toContain(it.source)
    }
  })

  it('tool-results (no filter) returns 515 results with toolName + text', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'tool-results' },
      REAL,
    )
    const d = r.details as {
      count: number
      shown: number
      items: Array<{ toolName: string; text: string }>
    }
    expect(d.count).toBe(515) // 全量 toolResult（design §1：515 toolResult）
    expect(d.shown).toBeLessThanOrEqual(d.count)
    expect(
      d.items.every((it) => typeof it.toolName === 'string' && typeof it.text === 'string'),
    ).toBe(true)
  })

  it('tool-results tool=bash returns 309 all bash', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'tool-results', tool: 'bash' },
      REAL,
    )
    const d = r.details as { count: number; items: Array<{ toolName: string }> }
    expect(d.count).toBe(309)
    expect(d.items.every((it) => it.toolName === 'bash')).toBe(true)
  })

  it('tool-results tool=nonexist triggers F8 (no throw)', async () => {
    const r = await handleSessionRead(
      { action: 'extract', session: E6, what: 'tool-results', tool: 'nonexist' },
      REAL,
    )
    expect(r.content[0].text).toContain('无匹配')
    expect(r.content[0].text).toContain('bash×309')
  })

  it('F7 missing what throws with 无效 + valid values', async () => {
    // what 缺失是合法 SessionReadParams（optional），handler 层 F7 防御校验。
    // isExtractWhat 对 undefined 返 false → 同一 throw 路径，覆盖非法值场景。
    const params: SessionReadParams = { action: 'extract', session: E6 }
    await expect(handleSessionRead(params, REAL)).rejects.toThrow(/无效/)
    await expect(handleSessionRead(params, REAL)).rejects.toThrow(
      /user-messages\/commands\/files\/commits\/tool-results/,
    )
  })

  it('S2: extract turns 越界文案说明 extract turn 体系（不指向 outline）', async () => {
    // extract 用全量 entry 分段（含 compaction/旁支），turn index 与 outline leaf 视图不对齐
    let msg = ''
    try {
      await handleSessionRead(
        { action: 'extract', session: E6, what: 'user-messages', turns: 'T999' },
        REAL,
      )
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('extract 的 turn 范围与 outline 不同')
    expect(msg).not.toContain('用 outline 重看有效范围')
    expect(msg).toContain('该 session extract 共')
  })
})

// ---- fixture 工具（tmpdir 造最小 session 文件，供 F2/MF-5 用例）----

async function makeFixtureSession(
  dir: string,
  id: string,
  firstUserText: string,
): Promise<void> {
  const slug = '--demo-cwd--'
  await mkdir(join(dir, 'sessions', slug), { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', id, cwd: '/demo' }),
    JSON.stringify({
      type: 'message',
      id: id + '-m1',
      parentId: id,
      message: { role: 'user', content: [{ type: 'text', text: firstUserText }] },
    }),
  ]
  await writeFile(join(dir, 'sessions', slug, id + '.jsonl'), lines.join('\n') + '\n')
}

describe('F2 多匹配消歧（fixture，MF-9）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-f2-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('共享 uuid 片段 → 不抛错，content 含两候选 + 👉，details.ambiguous=true', async () => {
    const ID1 = '019e6c96-aaaa-bbbb-cccc-000000000001'
    const ID2 = '019e6c96-aaaa-bbbb-cccc-000000000002'
    await makeFixtureSession(dir, ID1, '第一段内容')
    await makeFixtureSession(dir, ID2, '第二段内容')

    // outline 走 resolveSessionId → 2 匹配 → F2 消歧（不抛错）
    const r = await handleSessionRead({ action: 'outline', session: '019e6c96-aaaa' }, dir)
    const d = r.details as { ambiguous: boolean; candidates: Array<{ sessionId: string }> }
    expect(d.ambiguous).toBe(true)
    expect(d.candidates).toHaveLength(2)
    expect(d.candidates.some((c) => c.sessionId === ID1)).toBe(true)
    expect(d.candidates.some((c) => c.sessionId === ID2)).toBe(true)
    const text = r.content[0].text
    expect(text).toContain(ID1)
    expect(text).toContain(ID2)
    expect(text).toContain('👉')
  })

  it('search/detail/expand/extract 同样走 F2 消歧（不抛错）', async () => {
    const ID1 = '019e6c96-aaaa-bbbb-cccc-000000000001'
    const ID2 = '019e6c96-aaaa-bbbb-cccc-000000000002'
    await makeFixtureSession(dir, ID1, '第一段内容')
    await makeFixtureSession(dir, ID2, '第二段内容')

    for (const action of ['detail', 'expand', 'search', 'export', 'extract'] as const) {
      const params: SessionReadParams = { action, session: '019e6c96-aaaa' }
      if (action === 'detail') params.turns = 'T001'
      if (action === 'expand') params.turn = 'T001'
      if (action === 'search') params.pattern = 'x'
      if (action === 'extract') params.what = 'user-messages'
      const r = await handleSessionRead(params, dir)
      const d = r.details as { ambiguous: boolean }
      expect(d.ambiguous, `action=${action}`).toBe(true)
      expect(r.content[0].text).toContain('👉')
    }
  })
})

describe('search 灾难性正则降级 + abort（fixture，MF-5 回归）', () => {
  let dir: string
  const SID = '019e6c96-bbbb-cccc-dddd-00000000000a'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-search-'))
    await makeFixtureSession(dir, SID, 'aaa plugin 内容')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('嵌套量词 pattern (a+)+ → 降级字面子串（不挂死，零命中）', async () => {
    const r = await handleSessionRead({ action: 'search', session: SID, pattern: '(a+)+' }, dir)
    const d = r.details as { hits: unknown[] }
    // 字面量 '(a+)+' 不在内容里 → 0 命中（若按正则执行会命中 'aaa' 且可能指数回溯）
    expect(d.hits).toHaveLength(0)
  })

  it('普通正则仍按正则匹配', async () => {
    const r = await handleSessionRead({ action: 'search', session: SID, pattern: 'a+' }, dir)
    const d = r.details as { hits: unknown[] }
    expect(d.hits.length).toBeGreaterThan(0)
  })

  it('范围量词 {m,n} 形态 → 降级字面子串（(a{1,3})*、(a{0,2})*、(a{1,3}){2,}，MF-1 回归）', async () => {
    for (const pattern of ['(a{1,3})*', '(a{0,2})*', '(a{1,3}){2,}']) {
      const r = await handleSessionRead({ action: 'search', session: SID, pattern }, dir)
      const d = r.details as { hits: unknown[] }
      // 字面量不含这些 pattern → 0 命中；若按正则执行会指数回溯挂死
      expect(d.hits, `pattern=${pattern}`).toHaveLength(0)
    }
  })

  it('alternation/嵌套量词分支 (a|aa)+、(a*)* → 降级字面子串（MF-5 分支回归）', async () => {
    for (const pattern of ['(a|aa)+', '(a*)*']) {
      const r = await handleSessionRead({ action: 'search', session: SID, pattern }, dir)
      const d = r.details as { hits: unknown[] }
      expect(d.hits, `pattern=${pattern}`).toHaveLength(0)
    }
  })

  it('(a{1,3}) 单独使用不被降级（组后无尾随量词，仍按正则执行）', async () => {
    const r = await handleSessionRead(
      { action: 'search', session: SID, pattern: '(a{1,3})' },
      dir,
    )
    const d = r.details as { hits: unknown[] }
    // 按正则执行命中 'aaa' → >0 命中（若被降级为字面量则 0 命中）
    expect(d.hits.length).toBeGreaterThan(0)
  })

  it('降级标注：header 含「已降级为字面子串匹配」（S-3）', async () => {
    const r = await handleSessionRead({ action: 'search', session: SID, pattern: '(a+)+' }, dir)
    expect(r.content[0].text).toContain('已降级为字面子串匹配')
  })

  it('非法正则 pattern → 字面子串兜底不抛错（零命中，S-6）', async () => {
    const r = await handleSessionRead({ action: 'search', session: SID, pattern: '[unclosed' }, dir)
    const d = r.details as { hits: unknown[] }
    expect(d.hits).toHaveLength(0)
  })

  it('scope 过滤：scope=assistant 零命中（fixture 仅 user 角色，S-6）', async () => {
    const r = await handleSessionRead(
      { action: 'search', session: SID, pattern: 'aaa', scope: 'assistant' },
      dir,
    )
    const d = r.details as { hits: unknown[] }
    expect(d.hits).toHaveLength(0)
  })

  it('limit 截断 → truncated=true + hits 限长（3 条命中 limit=2，S-6）', async () => {
    const sid2 = '019e6c96-bbbb-cccc-dddd-00000000000b'
    // message 链式 parentId（与真实 pi session 一致）：m0→session 根，m1→m0，m2→m1，
    // 否则 buildTreeView 只回溯最后一条的父链，前两条被当旁支过滤
    const lines = [
      JSON.stringify({ type: 'session', id: sid2, cwd: '/demo' }),
      ...['aa1', 'aa2', 'aa3'].map((t, i) =>
        JSON.stringify({
          type: 'message',
          id: `${sid2}-m${i}`,
          parentId: i === 0 ? sid2 : `${sid2}-m${i - 1}`,
          message: { role: 'user', content: [{ type: 'text', text: t }] },
        }),
      ),
    ]
    await writeFile(
      join(dir, 'sessions', '--demo-cwd--', `${sid2}.jsonl`),
      lines.join('\n') + '\n',
    )
    const r = await handleSessionRead(
      { action: 'search', session: sid2, pattern: 'aa', limit: 2 },
      dir,
    )
    const d = r.details as { hits: unknown[]; truncated: boolean }
    expect(d.truncated).toBe(true)
    expect(d.hits).toHaveLength(2)
  })

  it('aborted signal → search 抛中断错误（不继续扫描）', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      handleSessionRead({ action: 'search', session: SID, pattern: 'x' }, dir, ac.signal),
    ).rejects.toThrow(/中断/)
  })
})

describe('renderExtractItems F9 截断（S3 首项超大 + S4 文案）', () => {
  it('S3: 首项超大内部截断 → body 不超预算，shown<count + truncated=true', () => {
    // 首项 10000 字符 >> EXTRACT_BUDGET_BYTES(8000)；旧逻辑放行首项致 body≈10KB
    const longText = 'x'.repeat(10000)
    const items = [
      { turn: 5, text: longText },
      { turn: 6, text: 'short6' },
      { turn: 7, text: 'short7' },
    ]
    const r = renderExtractItems(
      'user-messages',
      items,
      (it) => `T${String(it.turn).padStart(3, '0')}: ${it.text}`,
      (it) => [it.turn],
    )
    const d = r.details as { what: string; count: number; shown: number; truncated: boolean }
    expect(d.truncated).toBe(true)
    expect(d.count).toBe(3)
    expect(d.shown).toBe(1) // 首项截断后保留，后续项因预算用未加入
    // body（含文案行）字节数远小于 3 项全量（30000+ 字节），≤ 预算 + 合理余量
    const bodyBytes = Buffer.byteLength(r.content[0].text, 'utf8')
    expect(bodyBytes).toBeLessThan(8000 * 1.5)
    // 截断标记存在（首项被内部 slice + 省略号）
    expect(r.content[0].text).toContain('…')
    // 完整 longText 不在输出里（已被截断）
    expect(r.content[0].text).not.toContain(longText)
  })

  it('S4: F9 文案含实际 turn 范围 + 实际 token（非固定 2000）', () => {
    // 3 项各 ~3000 字节，累计超 8000 → 第 3 项触发截断（文案报 shown turn 范围）
    const items = [
      { turn: 10, text: 'a'.repeat(3000) },
      { turn: 20, text: 'b'.repeat(3000) },
      { turn: 30, text: 'c'.repeat(3000) },
    ]
    const r = renderExtractItems(
      'user-messages',
      items,
      (it) => `T${String(it.turn).padStart(3, '0')}: ${it.text}`,
      (it) => [it.turn],
    )
    const text = r.content[0].text
    // 文案含 turn 范围（shown 的 min-max turn）
    expect(text).toMatch(/T010-T0\d{2}/)
    // 文案含实际 token（从 body 实际字节算），不再是固定 2000
    expect(text).toContain('token 达预算上限')
    expect(text).not.toContain('≈2000 token')
    // 文案含 shown/count
    expect(text).toMatch(/已显示 \d+\/\d+ 项/)
  })
})
