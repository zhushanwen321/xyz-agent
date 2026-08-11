import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  extractHashFragment,
  formatAge,
  toCandidate,
  computeUniquePrefix,
  provideHashCandidates,
  FRAGMENT_LEN,
  type AutocompleteCandidate,
} from '../tui/hash-provider.js'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'

/**
 * TUI 层纯逻辑单测（design §3.3 D-3/D-4 + 2026-08-10 重构）。
 *
 * 测三层：
 * 1. extractHashFragment：# 片段提取 + token 边界
 * 2. toCandidate / formatAge：SessionInfo → 候选转换 + 单单位时间
 * 3. provideHashCandidates：端到端（真实 tmpdir 造 session 文件，SessionManager.listAll 真跑，不 mock）
 */

// ---- fixture helper（造真实 pi session 文件，让 listAll 真实解析）----

async function makeSession(
  dir: string,
  opts: {
    fileName: string
    id: string
    cwd?: string
    name?: string
    firstUserText?: string
  },
): Promise<void> {
  const header: Record<string, unknown> = {
    type: 'session',
    version: 3,
    id: opts.id,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
  if (opts.cwd) header.cwd = opts.cwd
  const lines: unknown[] = [header]
  if (opts.name) {
    lines.push({ type: 'session_info', id: opts.id + '-info', name: opts.name })
  }
  if (opts.firstUserText) {
    lines.push({
      type: 'message',
      id: opts.id + '-m1',
      message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
    })
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, opts.fileName), lines.map((o) => JSON.stringify(o)).join('\n') + '\n')
}

/** 造 SessionInfo 对象（toCandidate 纯函数测试用，不经 listAll）。 */
function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    path: '/fake/019e6c96.jsonl',
    id: '019e6c96-aaaa-bbbb-cccc-dddddddddddd',
    cwd: '/demo',
    created: new Date('2026-01-01T00:00:00.000Z'),
    modified: new Date('2026-01-01T00:00:00.000Z'),
    messageCount: 14,
    firstMessage: '修复登录 bug',
    allMessagesText: '',
    ...overrides,
  }
}

// ---- extractHashFragment ----

describe('extractHashFragment', () => {
  it('行首 # + hex 片段', () => {
    expect(extractHashFragment('#e6c96')).toBe('e6c96')
  })

  it('空片段（刚输入 #）', () => {
    expect(extractHashFragment('#')).toBe('')
  })

  it('# 前是空格（token 边界）→ 命中', () => {
    expect(extractHashFragment('see #e6c9')).toBe('e6c9')
  })

  it('# 前是单词字符（foo#bar）→ null（防 hashtag 误触发）', () => {
    expect(extractHashFragment('foo#bar')).toBeNull()
  })

  it('非 # 前缀（纯文本）→ null', () => {
    expect(extractHashFragment('hello world')).toBeNull()
  })

  it('/ 命令前缀 → null（委托命令 provider）', () => {
    expect(extractHashFragment('/session-pick')).toBeNull()
  })

  it('@ 文件前缀 → null（委托文件 provider）', () => {
    expect(extractHashFragment('@path/to')).toBeNull()
  })

  it('片段含连字符（完整 uuid 片段）', () => {
    expect(extractHashFragment('#019e6c96-aaaa')).toBe('019e6c96-aaaa')
  })

  it('# 后跟非 hex 字符（#hello）→ null（非 uuid 片段，委托下家 provider）', () => {
    expect(extractHashFragment('#hello')).toBeNull()
    expect(extractHashFragment('#bug')).toBeNull()
  })
})

// ---- formatAge（单单位，对齐 /resume formatSessionDate）----

describe('formatAge', () => {
  const now = new Date('2026-01-15T12:00:00Z').getTime()

  it('< 1 分钟 → now', () => {
    expect(formatAge(now - 30_000, now)).toBe('now')
  })

  it('< 1 小时 → XXm（2位补零）', () => {
    expect(formatAge(now - 5 * 60_000, now)).toBe('05m')
    expect(formatAge(now - 59 * 60_000, now)).toBe('59m')
  })

  it('< 1 天 → XXh', () => {
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('03h')
    expect(formatAge(now - 23 * 3_600_000, now)).toBe('23h')
  })

  it('< 7 天 → XXd', () => {
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('02d')
  })

  it('< 30 天 → XXw', () => {
    expect(formatAge(now - 14 * 86_400_000, now)).toBe('02w')
  })

  it('< 365 天 → XXM（月单位 M，单字符与分钟 m 区分）', () => {
    expect(formatAge(now - 60 * 86_400_000, now)).toBe('02M')
  })

  it('≥ 365 天 → XXy', () => {
    expect(formatAge(now - 400 * 86_400_000, now)).toBe('01y')
  })

  it('接收 Date 对象（SessionInfo.modified 是 Date）', () => {
    expect(formatAge(new Date(now - 2 * 3_600_000), now)).toBe('02h')
  })

  it('未来时间（时钟偏移）→ now', () => {
    expect(formatAge(now + 10_000, now)).toBe('now')
  })

  it('固定等宽：除 now 外都是 3 字符（XXu，2位数字+1位单位，design G4 对齐）', () => {
    // 各档位抽样，都应 3 字符
    expect(formatAge(now - 90 * 60_000, now)).toBe('01h') // 90分=1h，补零
    expect(formatAge(now - 5 * 60_000, now).length).toBe(3)
    expect(formatAge(now - 3 * 3_600_000, now).length).toBe(3)
    expect(formatAge(now - 2 * 86_400_000, now).length).toBe(3)
    expect(formatAge(now - 60 * 86_400_000, now).length).toBe(3)
    expect(formatAge(now - 400 * 86_400_000, now).length).toBe(3)
    expect(formatAge(now - 30_000, now)).toBe('now') // now 也是 3 字符
  })
})

// ---- toCandidate（SessionInfo → AutocompleteCandidate）----

describe('toCandidate', () => {
  it('insertText = # + sessionId 前 8 字符（design D-3）', () => {
    const c = toCandidate(makeSessionInfo())
    expect(c.insertText).toBe('#019e6c96')
    expect(c.insertText.length).toBe(FRAGMENT_LEN + 1)
  })

  it('label = `${age} ${预览}`（时间最左 + 1 空格 + 预览；不设 description 触发满宽分支）', () => {
    const c = toCandidate(
      makeSessionInfo({ firstMessage: '修复登录 bug', messageCount: 14 }),
      [],
      new Date('2026-01-01T13:00:00Z').getTime(),
    )
    // modified=2026-01-01T00:00, now=13:00 → 13h
    expect(c.label).toBe('13h 修复登录 bug')
    // description 未设（undefined）——触发 SelectList 满宽 label 分支，绕过主列固定32
    expect(c.description).toBeUndefined()
  })

  it('有 name → label 放 name 不放 firstMessage（design G3）', () => {
    const c = toCandidate(
      makeSessionInfo({ name: 'my-session', firstMessage: '首条消息内容', messageCount: 5 }),
      [],
      new Date('2026-01-01T01:00:00Z').getTime(),
    )
    expect(c.label).toBe('01h my-session')
    expect(c.label).not.toContain('首条消息内容')
  })

  it('firstMessage 超长 → 截断到 PREVIEW_MAX（避免传超大字符串给 pi-tui）', () => {
    const longText = 'X'.repeat(500)
    const c = toCandidate(makeSessionInfo({ firstMessage: longText }), [], new Date('2026-01-01T01:00:00Z').getTime())
    // label = age(3) + 空格(1) + 截断text(100+…)
    expect(c.label).toMatch(/^01h X{100}…$/)
  })

  it('label 不含 uuid 片段、不含 count（用户反馈：不显示片段、不显示 count）', () => {
    const c = toCandidate(makeSessionInfo({ messageCount: 999 }))
    expect(c.label).not.toContain('019e6c96')
    expect(c.label).not.toContain('999')
  })

  it('firstMessage 含换行/控制符 → 清洗为单空格（避免破坏 SelectList 单行渲染）', () => {
    const c = toCandidate(makeSessionInfo({ firstMessage: '第一行\n第二行\t缩进' }))
    expect(c.label).not.toContain('\n')
    expect(c.label).not.toContain('\t')
    expect(c.label).toContain('第一行 第二行 缩进')
  })

  it('无 name 且无 firstMessage → 标 (无预览)', () => {
    const c = toCandidate(makeSessionInfo({ name: undefined, firstMessage: '' }))
    expect(c.label).toContain('(无预览)')
  })
})

// ---- computeUniquePrefix（D5：max LCP + 1 唯一前缀）----

describe('computeUniquePrefix', () => {
  it('2 元桶：019fea0e-c0cb... / 019fea0e-378e... → 各唯一前缀 019fea0e-c / 019fea0e-3', () => {
    const a = '019fea0e-c0cb-aaaa-bbbb-ccccdddddddd'
    const b = '019fea0e-378e-eeee-ffff-000000000000'
    const siblings = [a, b]
    expect(computeUniquePrefix(a, siblings)).toBe('019fea0e-c')
    expect(computeUniquePrefix(b, siblings)).toBe('019fea0e-3')
  })

  it('大桶（5 元同 8 字符前缀）：结果两两不同（验证取 max 方向，min 会失败）', () => {
    // 模拟 19 元桶子集，共享 019e9680 前 8 字符，第 9 位（连字符后）分叉
    const sids = [
      '019e9680-1111-aaaa-bbbb-cccccccccccc',
      '019e9680-2222-aaaa-bbbb-cccccccccccc',
      '019e9680-3333-aaaa-bbbb-cccccccccccc',
      '019e9680-4444-aaaa-bbbb-cccccccccccc',
      '019e9680-5555-aaaa-bbbb-cccccccccccc',
    ]
    const prefixes = sids.map((s) => computeUniquePrefix(s, sids))
    // 两两不同（Set 去重后数量等于 sid 数）
    expect(new Set(prefixes).size).toBe(sids.length)
    // 每个是 10 字符（019e9680-x，第 10 位区分）；min 错误会得 8 字符且全相同
    for (const p of prefixes) {
      expect(p).toHaveLength(10)
      expect(p.startsWith('019e9680-')).toBe(true)
    }
  })

  it('含子簇的大桶：同簇兄弟需更长前缀区分（max 方向核心验证）', () => {
    // 5 元：前 3 个共享 019e9680-111x（LCP=13），后 2 个共享 019e9680-222x
    const sids = [
      '019e9680-1111-aaaa-bbbb-cccccccccccc',
      '019e9680-1112-aaaa-bbbb-cccccccccccc',
      '019e9680-1113-aaaa-bbbb-cccccccccccc',
      '019e9680-2222-aaaa-bbbb-cccccccccccc',
      '019e9680-2223-aaaa-bbbb-cccccccccccc',
    ]
    const prefixes = sids.map((s) => computeUniquePrefix(s, sids))
    expect(new Set(prefixes).size).toBe(sids.length)
    // 子簇内最像兄弟 LCP=13 → 需 slice(0,14)（14 字符）区分
    // min 错误会取跨簇 LCP=9 → slice(0,10)=019e9680-1，子簇内 3 个全碰撞
    expect(computeUniquePrefix(sids[0], sids)).toBe('019e9680-1111')
    expect(computeUniquePrefix(sids[1], sids)).toBe('019e9680-1112')
    expect(computeUniquePrefix(sids[3], sids)).toBe('019e9680-2222')
  })

  it('siblings 只含自己（无兄弟）→ maxLCP=0，slice(0,1)', () => {
    expect(computeUniquePrefix('019e9680-aaaa-bbbb', ['019e9680-aaaa-bbbb'])).toBe('0')
  })

  it('siblings 空数组 → slice(0,1)', () => {
    expect(computeUniquePrefix('019e9680-aaaa-bbbb', [])).toBe('0')
  })
})

// ---- toCandidate O5（碰撞唯一前缀）----

describe('toCandidate（O5 唯一前缀）', () => {
  it('多候选（siblings > 1）→ insertText 用唯一前缀（>8 字符）', () => {
    const a = makeSessionInfo({ id: '019fea0e-c0cb-aaaa-bbbb-ccccdddddddd' })
    const b = makeSessionInfo({ id: '019fea0e-378e-eeee-ffff-000000000000' })
    const siblings = [a.id, b.id]
    const ca = toCandidate(a, siblings)
    expect(ca.insertText).toBe('#019fea0e-c')
    expect(ca.insertText.length).toBeGreaterThan(FRAGMENT_LEN + 1)
    // label 不受影响（仍 age+预览，不含片段）
    expect(ca.label).not.toContain('019fea0e')
  })

  it('单候选（siblings 空）→ insertText 仍 8 字符（design D-3 契约）', () => {
    const c = toCandidate(makeSessionInfo(), [])
    expect(c.insertText).toBe('#019e6c96')
    expect(c.insertText.length).toBe(FRAGMENT_LEN + 1)
  })

  it('siblings 缺省 → insertText 仍 8 字符（向后兼容 session-command.ts 调用）', () => {
    const c = toCandidate(makeSessionInfo())
    expect(c.insertText).toBe('#019e6c96')
  })
})

// ---- provideHashCandidates（端到端，真实 tmpdir，listAll 真跑不 mock）----
// O5 修复后 fixture：agentDir/sessions/<cwdA|cwdB>/ 结构（模拟真实 pi 布局）。
// listAll(cwdSessionDir) 扫单 cwd；listGlobalSessionIds(agentDir) 扫全局（cwdA+cwdB）。

describe('provideHashCandidates', () => {
  let agentDir: string
  let cwdSessionDir: string
  let otherCwdDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'hash-test-'))
    cwdSessionDir = join(agentDir, 'sessions', 'cwdA')
    otherCwdDir = join(agentDir, 'sessions', 'cwdB')
    await mkdir(cwdSessionDir, { recursive: true })
    await mkdir(otherCwdDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  it('非 # 输入 → null（委托下家 provider）', async () => {
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    const result = await provideHashCandidates('hello world', cwdSessionDir, agentDir)
    expect(result).toBeNull()
  })

  it('# 空片段 → recent 候选（当前目录全部 session，退化为 8 字符浏览态）', async () => {
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    await makeSession(cwdSessionDir, { fileName: 'b.jsonl', id: '019fffff-cccc-dddd', cwd: '/demo' })
    const result = await provideHashCandidates('#', cwdSessionDir, agentDir)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(2)
    // 空 fragment = recent 浏览态 → 8 字符（有意设计，非全局唯一）
    expect(result!.every((c) => c.insertText.length === FRAGMENT_LEN + 1)).toBe(true)
  })

  it('#e6c9 片段 → id 子串过滤', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: '019e6c96-aaaa-bbbb',
      cwd: '/demo',
      firstUserText: '修复登录 bug',
    })
    await makeSession(cwdSessionDir, {
      fileName: 'b.jsonl',
      id: '019fffff-cccc-dddd',
      cwd: '/demo',
      firstUserText: '无关内容',
    })
    const result = await provideHashCandidates('#e6c9', cwdSessionDir, agentDir)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(1)
    expect(result![0].insertText).toBe('#019e6c96')
    // label = age+预览（不含片段、不含 count）；description 未设
    expect(result![0].label).not.toContain('019e6c96')
    expect(result![0].label).toContain('修复登录 bug')
    expect(result![0].description).toBeUndefined()
  })

  it('insertText 格式 #xxxxxxxx（单候选全局唯一 → 8 字符）', async () => {
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    const result = await provideHashCandidates('#019e', cwdSessionDir, agentDir)
    expect(result).not.toBeNull()
    const c = result![0] as AutocompleteCandidate
    expect(c.insertText).toMatch(/^#[0-9a-f]{8}$/i)
    expect(c.insertText).toBe('#019e6c96')
  })

  it('# 片段无匹配 → 空数组（不抛）', async () => {
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    const result = await provideHashCandidates('#deadbeef', cwdSessionDir, agentDir)
    expect(result).not.toBeNull()
    expect(result).toEqual([])
  })

  it('limit 限制返回数量', async () => {
    for (let i = 0; i < 5; i++) {
      await makeSession(cwdSessionDir, {
        fileName: `f${i}.jsonl`,
        id: `019e6c9${i}-aaaa-bbbb`,
        cwd: '/demo',
      })
    }
    const result = await provideHashCandidates('#019e6c9', cwdSessionDir, agentDir, { limit: 2 })
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(2)
  })

  it('空 cwdSessionDir → 返回空数组，不调 listAll（避免全盘扫描卡死）', async () => {
    const result = await provideHashCandidates('#abc', '', agentDir)
    expect(result).toEqual([])
  })

  it('visible 只扫当前 cwd 目录（design G1）；globalIds 扫全局但不影响 visible 长度', async () => {
    // cwdA（当前）有 1 个
    await makeSession(cwdSessionDir, { fileName: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    // otherCwdDir（其他 cwd）放一个不同前缀的，listAll(cwdA) 不扫它
    await makeSession(otherCwdDir, { fileName: 'other.jsonl', id: '019fffff-cccc-dddd', cwd: '/other' })
    const result = await provideHashCandidates('#', cwdSessionDir, agentDir)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(1)
    expect(result![0].insertText).toBe('#019e6c96')
  })

  it('有 name 的 session → label 含 name 不含 firstMessage（design G3）', async () => {
    await makeSession(cwdSessionDir, {
      fileName: 'named.jsonl',
      id: '019fffff-cccc-dddd',
      cwd: '/demo',
      name: 'my-named-session',
      firstUserText: '首条消息内容',
    })
    const result = await provideHashCandidates('#019f', cwdSessionDir, agentDir)
    expect(result!).toHaveLength(1)
    expect(result![0].label).toContain('my-named-session')
    expect(result![0].label).not.toContain('首条消息内容')
  })

  it('O5 单 cwd 碰撞桶：多匹配 → insertText 用全局唯一前缀（此处全局=单 cwd）', async () => {
    // 2 元桶 019fea0e：-c0cb / -378e，LCP=9，第 10 位区分。都在 cwdA → 全局=单 cwd
    const sids = [
      '019fea0e-c0cb-aaaa-bbbb-ccccdddddddd',
      '019fea0e-378e-eeee-ffff-000000000000',
    ]
    await makeSession(cwdSessionDir, {
      fileName: 'a.jsonl',
      id: sids[0],
      cwd: '/demo',
      firstUserText: '读取 pi session 的 extension 设计',
    })
    await makeSession(cwdSessionDir, {
      fileName: 'b.jsonl',
      id: sids[1],
      cwd: '/demo',
      firstUserText: 'settings provider 删除 bug 排查',
    })
    const result = await provideHashCandidates('#019fea0e', cwdSessionDir, agentDir)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(2)
    const inserts = result!.map((c) => c.insertText)
    expect(new Set(inserts).size).toBe(2)
    expect(inserts).toContain('#019fea0e-c')
    expect(inserts).toContain('#019fea0e-3')
    for (const ins of inserts) {
      const frag = ins.slice(1)
      expect(sids.filter((sid) => sid.includes(frag))).toHaveLength(1)
    }
  })

  it('O5 单 cwd 大桶（5 元同 8 字符前缀）：insertText 两两不同（拦截 min 方向退化）', async () => {
    const sids = [
      '019e9680-1111-aaaa-bbbb-cccccccccccc',
      '019e9680-2222-aaaa-bbbb-cccccccccccc',
      '019e9680-3333-aaaa-bbbb-cccccccccccc',
      '019e9680-4444-aaaa-bbbb-cccccccccccc',
      '019e9680-5555-aaaa-bbbb-cccccccccccc',
    ]
    for (let i = 0; i < sids.length; i++) {
      await makeSession(cwdSessionDir, {
        fileName: `s${i}.jsonl`,
        id: sids[i],
        cwd: '/demo',
        firstUserText: `session ${i}`,
      })
    }
    const result = await provideHashCandidates('#019e9680', cwdSessionDir, agentDir)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(5)
    const inserts = result!.map((c) => c.insertText)
    expect(new Set(inserts).size).toBe(5)
    for (const ins of inserts) {
      const frag = ins.slice(1)
      expect(sids.filter((sid) => sid.includes(frag))).toHaveLength(1)
    }
  })

  // ── O5 核心修复：跨 cwd 碰撞 + >limit（旧测试漏覆盖，bug 根因）──

  it('O5 跨 cwd 碰撞：cwdA 候选 insertText 延长到全局唯一（cwdB 有碰撞对手）', async () => {
    // cwdA 有 019fea0e-c0cb（visible 候选），cwdB 有 019fea0e-378e（碰撞对手）。
    // 修复前（per-cwd siblings=visible 1 个）→ 8 字符 #019fea0e → 全局 find 命中 cwdA+cwdB 2 个（bug）
    // 修复后（globalIds=2 个）→ 唯一前缀 #019fea0e-c → 全局命中 1 个
    const idA = '019fea0e-c0cb-aaaa-bbbb-ccccdddddddd'
    const idB = '019fea0e-378e-eeee-ffff-000000000000'
    await makeSession(cwdSessionDir, {
      fileName: `2026-01-01T00-00-00-000Z_${idA}.jsonl`,
      id: idA,
      cwd: '/demo',
      firstUserText: 'cwdA session',
    })
    await makeSession(otherCwdDir, {
      fileName: `2026-01-01T00-00-00-000Z_${idB}.jsonl`,
      id: idB,
      cwd: '/other',
      firstUserText: 'cwdB session',
    })
    const result = await provideHashCandidates('#019fea0e', cwdSessionDir, agentDir)
    expect(result).not.toBeNull()
    // visible 只含 cwdA（listAll(cwdSessionDir) 不扫 otherCwdDir）
    expect(result!).toHaveLength(1)
    // insertText 全局唯一：#019fea0e-c（LCP with 378e=9 → slice 10），非 per-cwd 的 #019fea0e
    expect(result![0].insertText).toBe('#019fea0e-c')
    expect(result![0].insertText.length).toBeGreaterThan(FRAGMENT_LEN + 1)
    // 关键验收：insertText 去#后在全局（cwdA+cwdB）只命中 1 个
    const frag = result![0].insertText.slice(1)
    const globalIds = [idA, idB]
    expect(globalIds.filter((id) => id.includes(frag))).toHaveLength(1)
  })

  it('O5 >limit：单 cwd 12 个同前缀（含长前缀邻居），limit=10，visible 的 insertText 在全局唯一', async () => {
    // 12 个同 8 字符前缀 019e9680。设计两对长前缀邻居（LCP=14）：
    //   1111-aaaa 与 1111-eeee；2222-aaaa 与 2222-eeee
    // limit=10 → visible=10（listAll 倒序截断），globalIds=12（全量）。
    // 修复前（per-cwd siblings=visible 10）：若长前缀邻居的一个在 visible 外，visible 内的算出
    //   短前缀（LCP=9 → 019e9680-1）→ 全局 find 命中 visible 内+外共 2 个（bug）
    // 修复后（globalIds=12）：长前缀邻居都在 globalIds → 算出唯一前缀 → 全局命中 1 个
    const sids = [
      '019e9680-1111-aaaa-bbbb-cccccccccccc',
      '019e9680-1111-eeee-ffff-000000000000', // 与 [0] LCP=14
      '019e9680-2222-aaaa-bbbb-cccccccccccc',
      '019e9680-2222-eeee-ffff-000000000001', // 与 [2] LCP=14
      '019e9680-3333-aaaa-bbbb-cccccccccccc',
      '019e9680-4444-aaaa-bbbb-cccccccccccc',
      '019e9680-5555-aaaa-bbbb-cccccccccccc',
      '019e9680-6666-aaaa-bbbb-cccccccccccc',
      '019e9680-7777-aaaa-bbbb-cccccccccccc',
      '019e9680-8888-aaaa-bbbb-cccccccccccc',
      '019e9680-9999-aaaa-bbbb-cccccccccccc',
      '019e9680-aaaa-aaaa-bbbb-cccccccccccc',
    ]
    for (let i = 0; i < sids.length; i++) {
      await makeSession(cwdSessionDir, {
        fileName: `2026-01-0${(i % 9) + 1}T00-00-00-00${i}Z_${sids[i]}.jsonl`,
        id: sids[i],
        cwd: '/demo',
        firstUserText: `session ${i}`,
      })
    }
    const result = await provideHashCandidates('#019e9680', cwdSessionDir, agentDir, { limit: 10 })
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(10) // visible 被 limit 截到 10
    // 修复核心：visible 的 insertText 用全局 12 个算唯一前缀，每个去#后在 12 个中唯一命中 1 个
    for (const c of result!) {
      const frag = c.insertText.slice(1)
      expect(sids.filter((id) => id.includes(frag))).toHaveLength(1)
    }
  })
})
