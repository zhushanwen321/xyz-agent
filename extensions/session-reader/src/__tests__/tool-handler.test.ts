import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { handleSessionRead, renderExtractItems, type SessionReadParams } from '../tool-handler.js'
import { listRecordManifests } from '../discovery/subagents.js'
import {
  REAL_AGENT_DIR as REAL,
  E6,
  FAM,
  HAS_E6,
  HAS_REAL,
  HAS_REAL_SUBAGENTS_DIR,
  hasRealSession,
} from './real-data.js'

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

  // w1 合并 subagent 候选后，本机 subagent task 文本（含本用例 query 字符串本身，因当前
  // wave 的 subagent task 引用了它）会触发 name-keyword fallback 命中 → 零匹配断言失败。
  // w2 实现 handler source 透传后，用 source:'main' 收窄到 main 侧避开 subagent 干扰
  //（w1 test 注释原预言的修复路径），同时恢复默认 timeout（main 单侧扫描快）。
  it('7. F1 find zero match returns empty matches + 👉 hint (no throw)', async () => {
    const r = await handleSessionRead(
      { action: 'find', query: 'zzz-nonexistent-session-9q8x2', source: 'main' },
      REAL,
    )
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

// ============================================================
// w2 新增：resolveSessionId 三形态（① 绝对路径 / ② sa-id / ③ findSessions 透传 source）
// + ES1/ES2 错误契约 + source 透传 + 真实数据守卫（design TC2-TC18）
// ============================================================

/**
 * 造 subagent manifest + session 文件（TC7/TC8/TC10/CQ3 用）。
 * sessionFileExists:false 模拟 GC（manifest 存在但 session 文件不存在 → ES1）。
 * 返回 session 文件绝对路径（= manifest.sessionFile）。
 */
async function makeFixtureSubagent(
  dir: string,
  saId: string,
  opts: {
    realSessionId: string
    rootSessionId?: string
    agentName?: string
    sessionFileExists?: boolean
    firstUserText?: string
  },
): Promise<string> {
  const slug = '--demo-cwd--'
  const sessionFile = join(dir, 'subagents', slug, 'sessions', `${opts.realSessionId}.jsonl`)
  if (opts.sessionFileExists !== false) {
    await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', id: opts.realSessionId, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: opts.realSessionId + '-m1',
        parentId: opts.realSessionId,
        message: {
          role: 'user',
          content: [{ type: 'text', text: opts.firstUserText ?? 'subagent work' }],
        },
      }),
    ]
    await writeFile(sessionFile, lines.join('\n') + '\n')
  }
  const recordsDir = join(dir, 'subagents', slug, 'records')
  await mkdir(recordsDir, { recursive: true })
  await writeFile(
    join(recordsDir, `${saId}.json`),
    JSON.stringify({
      id: saId,
      rootSessionId: opts.rootSessionId ?? 'root-session-1',
      agentName: opts.agentName ?? 'explorer',
      sessionFile,
    }),
  )
  return sessionFile
}

describe('resolveSessionId ① 绝对路径形态（w2 TC2-TC6）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-path-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('TC2: 绝对路径 outline → sessionId=header 真实 id（非文件名）', async () => {
    const fileId = '019e6c96-dddd-eeee-ffff-000000000b1'
    // 文件名 arbitrary-name 与 header id 不同，验 sessionId 取 header id
    const filePath = join(dir, 'sessions', '--demo-cwd--', 'arbitrary-name.jsonl')
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session', id: fileId, cwd: '/demo' }),
      JSON.stringify({
        type: 'message',
        id: fileId + '-m1',
        parentId: fileId,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }),
    ]
    await writeFile(filePath, lines.join('\n') + '\n')
    // export 的 details.path = session-view-<sessionId>.md，含 header 真实 id，不含文件名
    const r = await handleSessionRead(
      { action: 'export', session: filePath, format: 'outline' },
      dir,
    )
    const d = r.details as { path: string }
    expect(d.path).toContain(fileId)
    expect(d.path).not.toContain('arbitrary-name')
  })

  it('TC3: 绝对路径文件不存在 → F6 风格错误（含 👉）', async () => {
    const filePath = join(
      dir,
      'sessions',
      '--demo-cwd--',
      `not-exist-${Date.now()}.jsonl`,
    )
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, dir),
    ).rejects.toThrow(/读取失败.*文件不存在/)
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, dir),
    ).rejects.toThrow('👉')
  })

  it('TC4: 绝对路径非 .jsonl → F6 风格错误', async () => {
    const filePath = join(dir, 'sessions', '--demo-cwd--', 'x.txt')
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    await writeFile(filePath, 'not jsonl')
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, dir),
    ).rejects.toThrow(/读取失败.*非 \.jsonl/)
  })

  it('TC5: 绝对路径 header 读不出（首行非 session header）→ F6 风格错误', async () => {
    const filePath = join(dir, 'sessions', '--demo-cwd--', 'bad.jsonl')
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ type: 'custom', customType: 'x' }) + '\n')
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, dir),
    ).rejects.toThrow(/读取失败.*首行非合法 session header/)
  })

  it('TC5 变体: 绝对路径空文件 → F6 风格错误', async () => {
    const filePath = join(dir, 'sessions', '--demo-cwd--', 'empty.jsonl')
    await mkdir(join(dir, 'sessions', '--demo-cwd--'), { recursive: true })
    await writeFile(filePath, '')
    await expect(
      handleSessionRead({ action: 'outline', session: filePath }, dir),
    ).rejects.toThrow(/读取失败.*首行非合法 session header/)
  })

  it('TC6: ~ 前缀展开到 homedir（文件实际在 homedir 下）', async () => {
    const home = homedir()
    const tmpUnderHome = await mkdtemp(join(home, '.sr-w2-test-'))
    try {
      const fileId = '019e6c96-dddd-eeee-ffff-0000000006c1'
      const sessionFile = join(tmpUnderHome, 's.jsonl')
      await writeFile(
        sessionFile,
        JSON.stringify({ type: 'session', id: fileId, cwd: '/demo' }) + '\n',
      )
      // ~/开头的相对 homedir 路径
      const tildePath = '~/' + sessionFile.slice(home.length + 1)
      const r = await handleSessionRead(
        { action: 'export', session: tildePath, format: 'outline' },
        dir,
      )
      expect((r.details as { path: string }).path).toContain(fileId)
    } finally {
      await rm(tmpUnderHome, { recursive: true, force: true })
    }
  })
})

describe('resolveSessionId ② sa-id 形态（w2 TC7-TC10 + CQ3）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-said-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('TC7: sa-id 恰 1 命中 + sessionFile 存在 → 成功，sessionId=header 真实 id（非 sa-）', async () => {
    const realId = '019e6c96-dddd-eeee-ffff-0000000007a1'
    await makeFixtureSubagent(dir, 'sa-aaa', { realSessionId: realId, firstUserText: 'do task' })
    const r = await handleSessionRead(
      { action: 'export', session: 'sa-aaa', format: 'outline' },
      dir,
    )
    const d = r.details as { path: string }
    expect(d.path).toContain(realId)
    expect(d.path).not.toContain('sa-aaa')
  })

  it('TC8: sa-id 命中但 sessionFile 不存在（GC/未写入）→ ES1（含 manifest 元数据 + 👉）', async () => {
    await makeFixtureSubagent(dir, 'sa-gc', {
      realSessionId: '019e6c96-dddd-eeee-ffff-0000000008a2',
      rootSessionId: 'root-1',
      agentName: 'explorer',
      sessionFileExists: false,
    })
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-gc' }, dir),
    ).rejects.toThrow('session 文件不存在')
    // 错误含 manifest 全部元数据 + 👉
    try {
      await handleSessionRead({ action: 'outline', session: 'sa-gc' }, dir)
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('sa-gc')
      expect(msg).toContain('root-1')
      expect(msg).toContain('explorer')
      expect(msg).toContain('sessionFile:')
      expect(msg).toContain('👉')
      expect(msg).toContain('action:"family"')
    }
  })

  it('TC9: sa-id 0 命中（可能 running）→ ES2（含 family 指引 + 完整 id 提示 + 👉）', async () => {
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-nonexist-9999' }, dir),
    ).rejects.toThrow('无匹配 record')
    try {
      await handleSessionRead({ action: 'outline', session: 'sa-nonexist-9999' }, dir)
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('可能仍在运行')
      expect(msg).toContain('action:"family"')
      expect(msg).toContain('👉')
    }
  })

  it('TC10: sa-id 片段输入（精确相等不命中）→ ES2', async () => {
    await makeFixtureSubagent(dir, 'sa-c8c8dfa8', {
      realSessionId: '019e6c96-dddd-eeee-ffff-0000000010a3',
    })
    // 片段 sa-c8c8 不等于完整 sa-c8c8dfa8 → 精确相等不命中 → ES2
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-c8c8' }, dir),
    ).rejects.toThrow('无匹配 record')
  })

  it('sa-id 多 manifest 命中（数据异常）→ ES2 ambiguous（C4）', async () => {
    // 同 sa-id 的两个 manifest（不同 cwd slug 目录，模拟数据异常）
    for (const [slug, realId] of [
      ['--demo-cwd--', '019e6c96-dddd-eeee-ffff-0000000004a4'],
      ['--other-cwd--', '019e6c96-dddd-eeee-ffff-0000000004a5'],
    ] as const) {
      const sessionFile = join(dir, 'subagents', slug, 'sessions', `${realId}.jsonl`)
      await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
      await writeFile(
        sessionFile,
        JSON.stringify({ type: 'session', id: realId, cwd: '/demo' }) + '\n',
      )
      const recordsDir = join(dir, 'subagents', slug, 'records')
      await mkdir(recordsDir, { recursive: true })
      await writeFile(
        join(recordsDir, 'sa-dup.json'),
        JSON.stringify({
          id: 'sa-dup',
          rootSessionId: 'r',
          agentName: 'a',
          sessionFile,
        }),
      )
    }
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-dup' }, dir),
    ).rejects.toThrow(/匹配 2 个 record.*数据异常/)
  })

  it('CQ3: sa-id 命中但 sessionFile header 读不出 → F6 风格（不降级 record.id 当 sessionId）', async () => {
    // sessionFile 存在但首行非 session header → readSessionHeaderId 返 undefined
    const slug = '--demo-cwd--'
    const sessionFile = join(dir, 'subagents', slug, 'sessions', 'bad.jsonl')
    await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
    await writeFile(sessionFile, JSON.stringify({ type: 'custom', customType: 'x' }) + '\n')
    const recordsDir = join(dir, 'subagents', slug, 'records')
    await mkdir(recordsDir, { recursive: true })
    await writeFile(
      join(recordsDir, 'sa-bad.json'),
      JSON.stringify({
        id: 'sa-bad',
        rootSessionId: 'r',
        agentName: 'a',
        sessionFile,
      }),
    )
    // 抛 F6 风格（读取失败 + 首行非合法 session header），不降级返回 sa-bad 当 sessionId
    await expect(
      handleSessionRead({ action: 'outline', session: 'sa-bad' }, dir),
    ).rejects.toThrow(/读取失败.*首行非合法 session header/)
  })
})

describe('source 透传（w2 TC12-TC13，依赖 w1 findSessions opts.source）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-src-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('TC12: find source 过滤——subagent 只返回 subagent 候选，main 只返回 main', async () => {
    const sharedFragment = '019e6c96'
    const mainId = `${sharedFragment}-aaaa-bbbb-cccc-0000000012d1`
    const subId = `${sharedFragment}-aaaa-bbbb-cccc-0000000012d2`
    await makeFixtureSession(dir, mainId, 'main content')
    await makeFixtureSubagent(dir, 'sa-sub12', { realSessionId: subId, firstUserText: 'sub content' })

    // 无 source → 两者
    const rBoth = await handleSessionRead(
      { action: 'find', query: sharedFragment },
      dir,
    )
    const dBoth = rBoth.details as {
      matches: Array<{ source: string; sessionId: string }>
    }
    expect(dBoth.matches.some((m) => m.sessionId === mainId)).toBe(true)
    expect(dBoth.matches.some((m) => m.sessionId === subId)).toBe(true)

    // source:subagent → 只 sub
    const rSub = await handleSessionRead(
      { action: 'find', query: sharedFragment, source: 'subagent' },
      dir,
    )
    const dSub = rSub.details as {
      matches: Array<{ source: string; sessionId: string }>
    }
    expect(dSub.matches.every((m) => m.source === 'subagent')).toBe(true)
    expect(dSub.matches.some((m) => m.sessionId === subId)).toBe(true)
    expect(dSub.matches.some((m) => m.sessionId === mainId)).toBe(false)

    // source:main → 只 main
    const rMain = await handleSessionRead(
      { action: 'find', query: sharedFragment, source: 'main' },
      dir,
    )
    const dMain = rMain.details as {
      matches: Array<{ source: string; sessionId: string }>
    }
    expect(dMain.matches.every((m) => m.source === 'main')).toBe(true)
    expect(dMain.matches.some((m) => m.sessionId === mainId)).toBe(true)
    expect(dMain.matches.some((m) => m.sessionId === subId)).toBe(false)
  })

  it('TC13: outline source:main → resolveSessionId ③ 收窄到 main 候选（无 source 时多匹配 F2）', async () => {
    const sharedFragment = '019e6c96'
    const mainId = `${sharedFragment}-aaaa-bbbb-cccc-0000000013e1`
    const subId = `${sharedFragment}-aaaa-bbbb-cccc-0000000013e2`
    await makeFixtureSession(dir, mainId, 'main content')
    await makeFixtureSubagent(dir, 'sa-sub13', { realSessionId: subId, firstUserText: 'sub content' })

    // 无 source → main+sub 共享片段 → 2 匹配 → F2 消歧
    const rMulti = await handleSessionRead(
      { action: 'outline', session: sharedFragment },
      dir,
    )
    expect((rMulti.details as { ambiguous: boolean }).ambiguous).toBe(true)

    // source:main → 收窄到 main → 唯一匹配 → outline 成功，且是 main（export path 含 mainId）
    const rExp = await handleSessionRead(
      { action: 'export', session: sharedFragment, source: 'main', format: 'outline' },
      dir,
    )
    expect((rExp.details as { path: string }).path).toContain(mainId)
  })
})

describe.skipIf(!HAS_REAL_SUBAGENTS_DIR)('真实数据：subagent sa-id（w2 TC14-TC18）', () => {
  it('TC14: completed subagent sa-id outline 成功（场景 1，sessionId=header 真实 id）', async () => {
    const manifests = await listRecordManifests(REAL)
    const alive = manifests.filter((m) => existsSync(m.sessionFile))
    if (alive.length === 0) return // 本机无存活 manifest 则跳过（skipIf 只守卫目录存在）
    const r = await handleSessionRead({ action: 'outline', session: alive[0].id }, REAL)
    const d = r.details as { turns: unknown[] }
    expect(d.turns.length).toBeGreaterThan(0)
  })

  it('TC15: worktree 编码目录 subagent 读取（场景 1b，递归扫描覆盖）', async () => {
    const manifests = await listRecordManifests(REAL)
    const wt = manifests.filter(
      (m) => m.sessionFile.includes('--private-var-folders-') && existsSync(m.sessionFile),
    )
    if (wt.length === 0) return // 本机无 worktree 编码目录数据则跳过
    const r = await handleSessionRead({ action: 'outline', session: wt[0].id }, REAL)
    expect(((r.details as { turns: unknown[] }).turns).length).toBeGreaterThan(0)
  })

  it('TC16: 嵌套后代直接 outline（场景 1c，绝对路径形态读任意节点）', async () => {
    const manifests = await listRecordManifests(REAL)
    const alive = manifests.filter((m) => existsSync(m.sessionFile))
    if (alive.length === 0) return
    // 绝对路径形态直接读（M0 入口不依赖 findSessions）
    const r = await handleSessionRead(
      { action: 'outline', session: alive[0].sessionFile },
      REAL,
    )
    expect(((r.details as { turns: unknown[] }).turns).length).toBeGreaterThan(0)
  })

  it('TC17: GC/failed manifest → ES1（场景 4，sessionFile 不存在）', async () => {
    const manifests = await listRecordManifests(REAL)
    const gc = manifests.filter((m) => !existsSync(m.sessionFile))
    if (gc.length === 0) return // 本机无 GC 数据则跳过
    await expect(
      handleSessionRead({ action: 'outline', session: gc[0].id }, REAL),
    ).rejects.toThrow('session 文件不存在')
  })

  it('TC18: 不存在 sa-id → ES2（场景 4，可能 running 指引）', async () => {
    const fakeId = `sa-nonexist-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`
    await expect(
      handleSessionRead({ action: 'outline', session: fakeId }, REAL),
    ).rejects.toThrow('无匹配 record')
  })
})

// ============================================================
// w6: doWorkflow action（TC-w6-single-run/multi-run/runid-filter/runid-not-found/no-runs/snapshot-skip/call-jump）
// ============================================================

// ---- workflow fixture 常量（uuid 特征，互不为子串）----
const WF_ROOT = '019w6aaa-0000-7000-b000-000000000001' // 发起 workflow 的 main session
const WF_CALL = '019w6bbb-0000-7000-b000-000000000002' // workflow call 的目标 session（call-jump）
const SUB_WF_ROOT = '019w6ccc-0000-7000-b000-000000000003' // 发起 workflow 的 subagent session（MF-2）

/** 写 main session（header + 1 条 user message，让 outline 有 turn）。返回绝对路径。 */
async function wfMainSession(
  dir: string,
  slug: string,
  id: string,
  opts?: { cwd?: string },
): Promise<string> {
  const sessionDir = join(dir, 'sessions', slug)
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, `${id}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session', id, cwd: opts?.cwd ?? `/proj/${slug}` }),
    JSON.stringify({
      type: 'message',
      id: `${id}-m1`,
      parentId: id,
      message: { role: 'user', content: [{ type: 'text', text: 'run workflow' }] },
    }),
  ]
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/** 写 wf-state 文件（每行一个快照 JSON）。返回绝对路径。 */
async function wfStateFile(
  dir: string,
  slug: string,
  fileName: string,
  lines: string[],
): Promise<string> {
  const wfDir = join(dir, 'sessions', slug, 'workflow-state')
  await mkdir(wfDir, { recursive: true })
  const path = join(wfDir, fileName)
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

/** 向 main session 追加 workflow-state-link custom entry（resolveWorkflows 的输入）。 */
async function wfLink(
  dir: string,
  slug: string,
  id: string,
  link: { runId: string; path: string },
): Promise<void> {
  const sessionPath = join(dir, 'sessions', slug, `${id}.jsonl`)
  const line = JSON.stringify({
    type: 'custom',
    id: `wf-link-${link.runId}`,
    parentId: id,
    customType: 'workflow-state-link',
    data: { runId: link.runId, path: link.path, updatedAt: '2026-08-12T00:00:00Z' },
    timestamp: '2026-08-12T00:00:00Z',
  })
  await writeFile(sessionPath, line + '\n', { flag: 'a' })
}

/** 构造 NEW 格式 wf-state 快照 JSON 行（calls 含 sessionId/sessionFile，parseRunSnapshot 透传）。 */
function wfSnapshotNew(
  runId: string,
  calls: Array<{ sessionId: string; sessionFile: string; description?: string }>,
): string {
  return JSON.stringify({
    v: 'wf-run-v1',
    runId,
    spec: { scriptName: 'test-wf', name: 'Test' },
    state: {
      status: 'done',
      reason: 'completed',
      budget: {
        usedTokens: 100,
        usedCost: 0,
        totalCallCount: calls.length,
        maxTokens: 10000,
      },
      calls: calls.map((c, i) => ({
        id: i,
        opts: {
          prompt: 'do work',
          model: 'test-model',
          description: c.description ?? `step-${i}`,
        },
        status: 'done',
        attempts: 1,
        result: {
          content: 'ok',
          durationMs: 100,
          sessionId: c.sessionId,
          sessionFile: c.sessionFile,
        },
        sessionId: c.sessionId,
        sessionFile: c.sessionFile,
      })),
    },
    meta: { startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z' },
  })
}

describe('doWorkflow（w6，fixture）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-wf-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('TC-w6-single-run：单 run 概览，content 含 run 头行/budget/step，details.runs/runIds 非空', async () => {
    const slug = '--wf-single--'
    await wfMainSession(dir, slug, WF_ROOT)
    const callSession = join(dir, 'sessions', slug, `${WF_CALL}.jsonl`)
    const wfPath = await wfStateFile(dir, slug, 'wf-single.jsonl', [
      wfSnapshotNew('wf-single-1', [
        { sessionId: WF_CALL, sessionFile: callSession, description: 'probe-step' },
      ]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-single-1', path: wfPath })

    const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, dir)
    const d = r.details as {
      runs: Array<{
        runId: string
        status: string
        steps: Array<{ sessionId: string; sessionFile: string }>
      }>
      runIds: string[]
    }
    expect(d.runs).toHaveLength(1)
    expect(d.runs[0].runId).toBe('wf-single-1')
    expect(d.runs[0].status).toBe('done')
    expect(d.runs[0].steps).toHaveLength(1)
    expect(d.runs[0].steps[0].sessionId).toBe(WF_CALL)
    expect(d.runs[0].steps[0].sessionFile).toBe(callSession)
    expect(d.runIds).toEqual(['wf-single-1'])
    // content 含 renderWorkflowOverview 输出
    const text = r.content[0].text
    expect(text).toContain('run: wf-single-1')
    expect(text).toContain('[done]')
    expect(text).toContain('budget:')
    expect(text).toContain('#0')
    expect(text).toContain('call=' + WF_CALL.slice(0, 12))
    expect(text).toContain(callSession)
  })

  it('TC-w6-multi-run：多 run 拼接，content 含两段 overview，runs.length===2', async () => {
    const slug = '--wf-multi--'
    await wfMainSession(dir, slug, WF_ROOT)
    const wf1 = await wfStateFile(dir, slug, 'wf-1.jsonl', [
      wfSnapshotNew('wf-multi-1', [{ sessionId: WF_CALL, sessionFile: '/abs/a.jsonl' }]),
    ])
    const wf2 = await wfStateFile(dir, slug, 'wf-2.jsonl', [
      wfSnapshotNew('wf-multi-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-multi-1', path: wf1 })
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-multi-2', path: wf2 })

    const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, dir)
    const d = r.details as { runs: Array<{ runId: string }>; runIds: string[] }
    expect(d.runs).toHaveLength(2)
    expect(d.runIds).toHaveLength(2)
    expect(d.runIds).toContain('wf-multi-1')
    expect(d.runIds).toContain('wf-multi-2')
    const text = r.content[0].text
    expect(text).toContain('run: wf-multi-1')
    expect(text).toContain('run: wf-multi-2')
  })

  it('TC-w6-runid-filter：runId 过滤命中单 run', async () => {
    const slug = '--wf-filter--'
    await wfMainSession(dir, slug, WF_ROOT)
    const wf1 = await wfStateFile(dir, slug, 'wf-1.jsonl', [
      wfSnapshotNew('wf-filter-1', [{ sessionId: WF_CALL, sessionFile: '/abs/a.jsonl' }]),
    ])
    const wf2 = await wfStateFile(dir, slug, 'wf-2.jsonl', [
      wfSnapshotNew('wf-filter-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-filter-1', path: wf1 })
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-filter-2', path: wf2 })

    const r = await handleSessionRead(
      { action: 'workflow', session: WF_ROOT, runId: 'wf-filter-1' },
      dir,
    )
    const d = r.details as {
      runs: Array<{ runId: string }>
      runIds: string[]
      requestedRunId?: string
    }
    expect(d.runs).toHaveLength(1)
    expect(d.runIds).toEqual(['wf-filter-1'])
    expect(d.requestedRunId).toBe('wf-filter-1')
    const text = r.content[0].text
    expect(text).toContain('run: wf-filter-1')
    expect(text).not.toContain('run: wf-filter-2')
  })

  it('TC-w6-runid-not-found：runId 无匹配→ES-wf-runid-not-found（列候选+👉，不抛错）', async () => {
    const slug = '--wf-notfound--'
    await wfMainSession(dir, slug, WF_ROOT)
    const wf1 = await wfStateFile(dir, slug, 'wf-1.jsonl', [
      wfSnapshotNew('wf-nf-1', [{ sessionId: WF_CALL, sessionFile: '/abs/a.jsonl' }]),
    ])
    const wf2 = await wfStateFile(dir, slug, 'wf-2.jsonl', [
      wfSnapshotNew('wf-nf-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-nf-1', path: wf1 })
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-nf-2', path: wf2 })

    const r = await handleSessionRead(
      { action: 'workflow', session: WF_ROOT, runId: 'wf-nonexist' },
      dir,
    )
    const d = r.details as { runs: unknown[]; runIds: string[]; requestedRunId?: string }
    expect(d.runs).toEqual([])
    expect(d.runIds).toContain('wf-nf-1')
    expect(d.runIds).toContain('wf-nf-2')
    expect(d.requestedRunId).toBe('wf-nonexist')
    const text = r.content[0].text
    expect(text).toContain('wf-nonexist')
    expect(text).toContain('wf-nf-1')
    expect(text).toContain('wf-nf-2')
    expect(text).toContain('👉')
  })

  it('TC-w6-no-runs：无 workflow run→ES-wf-no-runs（提示+👉family，不抛错）', async () => {
    const slug = '--wf-noruns--'
    await wfMainSession(dir, slug, WF_ROOT)
    // 无 wf-link（session 存在但未发起 workflow）

    const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, dir)
    const d = r.details as { runs: unknown[]; runIds: unknown[]; sessionId?: string }
    expect(d.runs).toEqual([])
    expect(d.runIds).toEqual([])
    expect(d.sessionId).toBe(WF_ROOT)
    const text = r.content[0].text
    expect(text).toContain('无 workflow run')
    expect(text).toContain('👉')
    expect(text).toContain('family')
  })

  it('TC-w6-snapshot-skip：run1 wf-state 不存在→跳过，run2 正常（ES-wf-snapshot-read-fail）', async () => {
    const slug = '--wf-skip--'
    await wfMainSession(dir, slug, WF_ROOT)
    // run1 的 wf-state 文件不存在（link 指向不存在路径，模拟 GC）
    const ghostPath = join(dir, 'sessions', slug, 'workflow-state', 'wf-ghost.jsonl')
    const wf2 = await wfStateFile(dir, slug, 'wf-2.jsonl', [
      wfSnapshotNew('wf-skip-2', [{ sessionId: WF_CALL, sessionFile: '/abs/b.jsonl' }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-skip-1', path: ghostPath })
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-skip-2', path: wf2 })

    const r = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, dir)
    const d = r.details as {
      runs: Array<{ runId: string }>
      runIds: string[]
      skippedRuns?: Array<{ runId: string; stateFile: string; reason: string }>
    }
    expect(d.runs).toHaveLength(1)
    expect(d.runs[0].runId).toBe('wf-skip-2')
    expect(d.runIds).toEqual(['wf-skip-2'])
    expect(d.skippedRuns).toBeDefined()
    expect(d.skippedRuns).toHaveLength(1)
    expect(d.skippedRuns![0].runId).toBe('wf-skip-1')
    expect(d.skippedRuns![0].reason).toBe('snapshot-unreadable')
    const text = r.content[0].text
    expect(text).toContain('wf-skip-1')
    expect(text).toContain('已跳过')
    expect(text).toContain('run: wf-skip-2')
  })

  it('TC-w6-call-jump：workflow 概览 call sessionId 可被 resolveSessionId 深读（outline 跳转，§7 场景 2）', async () => {
    const slug = '--wf-jump--'
    await wfMainSession(dir, slug, WF_ROOT)
    // 真实存在的 call session（main session 形态，findSessions 可匹配）
    const callPath = await wfMainSession(dir, slug, WF_CALL, { cwd: '/proj/call' })
    const wfPath = await wfStateFile(dir, slug, 'wf-jump.jsonl', [
      wfSnapshotNew('wf-jump-1', [{ sessionId: WF_CALL, sessionFile: callPath }]),
    ])
    await wfLink(dir, slug, WF_ROOT, { runId: 'wf-jump-1', path: wfPath })

    // 第一次：workflow 概览，拿 call sessionId
    const rWf = await handleSessionRead({ action: 'workflow', session: WF_ROOT }, dir)
    const dWf = rWf.details as {
      runs: Array<{ steps: Array<{ sessionId: string; sessionFile: string }> }>
    }
    expect(dWf.runs).toHaveLength(1)
    const callSessionId = dWf.runs[0].steps[0].sessionId
    expect(callSessionId).toBe(WF_CALL)

    // 第二次：用 call sessionId 调 outline（m0 resolveSessionId 三形态复用）
    const rOutline = await handleSessionRead(
      { action: 'outline', session: callSessionId },
      dir,
    )
    const dOutline = rOutline.details as { turns: unknown[] }
    expect(dOutline.turns.length).toBeGreaterThan(0)
  })

  it('TC-w6-subagent-session：workflow action 对 subagent session 直读 wf-link 不抛错（MF-2）', async () => {
    const slug = '--wf-subagent--'
    // subagent session 放 subagents/ 下（不在 sessions/——buildFamilyFromFs 的 main byId
    // 索引外，旧实现 resolveFamily 找不到会抛「session not found in family index」）
    const subDir = join(dir, 'subagents', slug, 'sessions')
    await mkdir(subDir, { recursive: true })
    const subPath = join(subDir, `${SUB_WF_ROOT}.jsonl`)
    await writeFile(
      subPath,
      JSON.stringify({ type: 'session', id: SUB_WF_ROOT, cwd: `/proj/${slug}` }) + '\n',
    )
    const callSession = join(dir, 'sessions', slug, `${WF_CALL}.jsonl`)
    const wfPath = await wfStateFile(dir, slug, 'wf-sub.jsonl', [
      wfSnapshotNew('wf-sub-1', [
        { sessionId: WF_CALL, sessionFile: callSession, description: 'sub-step' },
      ]),
    ])
    // subagent session 的 workflow-state-link（wfLink helper 只写 sessions/，此处直接追加）
    await writeFile(
      subPath,
      JSON.stringify({
        type: 'custom',
        id: 'wf-link-wf-sub-1',
        parentId: SUB_WF_ROOT,
        customType: 'workflow-state-link',
        data: { runId: 'wf-sub-1', path: wfPath, updatedAt: '2026-08-12T00:00:00Z' },
        timestamp: '2026-08-12T00:00:00Z',
      }) + '\n',
      { flag: 'a' },
    )

    const r = await handleSessionRead({ action: 'workflow', session: SUB_WF_ROOT }, dir)
    const d = r.details as { runs: Array<{ runId: string }>; runIds: string[] }
    expect(d.runs).toHaveLength(1)
    expect(d.runs[0].runId).toBe('wf-sub-1')
    expect(d.runIds).toEqual(['wf-sub-1'])
    expect(r.content[0].text).toContain('run: wf-sub-1')
    expect(r.content[0].text).toContain('call=')
  })
})

// ============================================================
// 真实数据守卫：doWorkflow（CI 无本机数据时 skipIf 跳过）
// ============================================================

const REAL_WF_SESSION = '019fdcda-75c7-74b7-a160-f67f6bf88384'
const HAS_REAL_WF_SESSION = HAS_REAL && hasRealSession(REAL_WF_SESSION)

describe.skipIf(!HAS_REAL_WF_SESSION)('doWorkflow - 真实数据守卫', () => {
  it('TC-w6-real-data-guard：真实 workflow session doWorkflow 返回 run 概览', async () => {
    const r = await handleSessionRead(
      { action: 'workflow', session: REAL_WF_SESSION },
      REAL,
    )
    const d = r.details as {
      runs: Array<{ runId: string; status: string; steps: unknown[] }>
      runIds: string[]
    }
    expect(d.runs.length).toBeGreaterThan(0)
    expect(d.runIds.length).toBe(d.runs.length)
    // content 含 run 头行 + budget 行
    expect(r.content[0].text).toContain('run:')
    expect(r.content[0].text).toContain('budget:')
  }, 30000)
})

// ============================================================
// m3b：doFamily recursive false/true（TC-m3b-dofamily-recursive-false/true）
// ============================================================

describe('doFamily recursive（m3b U8 接入）', () => {
  let dir: string
  const MAIN = '019e6c96-cccc-dddd-eeee-000000000001'
  const SUB = '019e6c96-cccc-dddd-eeee-000000000002'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-handler-recursive-'))
    await makeFixtureSession(dir, MAIN, 'main session 内容')
    // 顶层 subagent（rootSessionId=MAIN，无 parentRecordId → flat 回退）
    await makeFixtureSubagent(dir, `sa-${SUB.slice(0, 8)}`, {
      realSessionId: SUB,
      rootSessionId: MAIN,
      agentName: 'explorer',
      firstUserText: 'subagent task',
    })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('TC-m3b-dofamily-recursive-false：不传 recursive → flat family（m0-m2 零回归）', async () => {
    const r = await handleSessionRead({ action: 'family', session: MAIN }, dir)
    // details 是 Family 对象（root/subagents/workflows），非 { tree }
    const d = r.details as {
      root: { sessionId: string }
      subagents: Array<{ sessionId: string; rootSessionId: string }>
      workflows: unknown[]
    }
    expect(d.root.sessionId).toBe(MAIN)
    expect(d.subagents.some((s) => s.sessionId === SUB)).toBe(true)
    expect(Array.isArray(d.workflows)).toBe(true)
    // content 是 formatFamilyText（非 formatExecutionTreeText）
    expect(r.content[0].text).toContain('root:')
    expect(r.content[0].text).not.toContain('execution tree')
  })

  it('TC-m3b-dofamily-recursive-true：recursive=true → ExecutionTree（details.tree）', async () => {
    const r = await handleSessionRead(
      { action: 'family', session: MAIN, recursive: true },
      dir,
    )
    const d = r.details as {
      tree: {
        root: { type: string; sessionId: string; children: unknown[] }
        totalNodes: number
        maxDepth: number
        sourceMode: string
        truncated: boolean
      }
    }
    expect(d.tree).toBeDefined()
    expect(d.tree.root.type).toBe('main')
    expect(d.tree.root.sessionId).toBe(MAIN)
    // subagent 挂 root（flat 回退，无 parentRecordId）
    expect(d.tree.root.children).toHaveLength(1)
    expect(d.tree.totalNodes).toBe(2) // main + subagent
    expect(d.tree.sourceMode).toBe('flat-fallback') // 旧机制无 parentRecordId
    expect(d.tree.truncated).toBe(false)
    // content 是 formatExecutionTreeText（含 execution tree 头部）
    expect(r.content[0].text).toContain('execution tree')
    expect(r.content[0].text).toContain('node(s)')
    expect(r.content[0].text).toContain('👉')
  })
})
