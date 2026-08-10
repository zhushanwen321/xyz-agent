import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  extractHashFragment,
  formatRelativeTime,
  toCandidate,
  provideHashCandidates,
  FRAGMENT_LEN,
  type AutocompleteCandidate,
} from '../tui/hash-provider.js'
import type { MatchedSession } from '../discovery/find.js'

/**
 * M4 TUI 层纯逻辑单测（design §3.3 D-3/D-4）。
 *
 * 测三层：
 * 1. extractHashFragment：# 片段提取 + token 边界
 * 2. toCandidate / formatRelativeTime：MatchedSession → 候选转换
 * 3. provideHashCandidates：端到端（真实 tmpdir 造 session，不 mock findSessions——
 *    同 find.test.ts 风格，覆盖 findSessions + toCandidate）
 */

// ---- fixture helper（同 find.test.ts，造真实 session 文件）----

async function makeSession(
  dir: string,
  opts: {
    name: string
    id: string
    cwd?: string
    firstUserText?: string
  },
): Promise<string> {
  const header: Record<string, unknown> = {
    type: 'session',
    id: opts.id,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
  if (opts.cwd) header.cwd = opts.cwd
  const lines = [JSON.stringify(header)]
  if (opts.firstUserText) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: opts.id + '-m1',
        message: { role: 'user', content: [{ type: 'text', text: opts.firstUserText }] },
      }),
    )
  }
  await mkdir(dir, { recursive: true })
  const path = join(dir, opts.name)
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

function makeMatchedSession(overrides: Partial<MatchedSession> = {}): MatchedSession {
  return {
    sessionId: '019e6c96-aaaa-bbbb-cccc-dddddddddddd',
    fileName: '/fake/019e6c96.jsonl',
    mtime: Date.now() - 3_600_000, // 1 小时前
    sizeBytes: 1024,
    cwd: '/demo',
    firstMessagePreview: '修复登录 bug',
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
    expect(extractHashFragment('/session')).toBeNull()
  })

  it('@ 文件前缀 → null（委托文件 provider）', () => {
    expect(extractHashFragment('@path/to')).toBeNull()
  })

  it('片段含连字符（完整 uuid 片段）', () => {
    expect(extractHashFragment('#019e6c96-aaaa')).toBe('019e6c96-aaaa')
  })

  it('# 后跟非 hex 字符（#hello）→ null（非 uuid 片段，委托下家 provider）', () => {
    // # 只认 uuid 片段（hex/-）。#hello / #bug 这类 hashtag / markdown heading 不触发，
    // 避免 hash provider 吞掉非引用语义的 #。名称查找走 /session 命令。
    expect(extractHashFragment('#hello')).toBeNull()
    expect(extractHashFragment('#bug')).toBeNull()
  })
})

// ---- formatRelativeTime ----

describe('formatRelativeTime', () => {
  const now = new Date('2026-01-15T12:00:00Z').getTime()

  it('刚刚（< 1 分钟）', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚')
  })

  it('分钟前', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
  })

  it('小时前', () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
  })

  it('天前', () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2 天前')
  })

  it('未来时间（时钟偏移）→ 刚刚', () => {
    expect(formatRelativeTime(now + 10_000, now)).toBe('刚刚')
  })
})

// ---- toCandidate ----

describe('toCandidate', () => {
  it('insertText = # + sessionId 前 8 字符（design D-3）', () => {
    const c = toCandidate(makeMatchedSession())
    expect(c.insertText).toBe('#019e6c96')
    expect(c.insertText.length).toBe(FRAGMENT_LEN + 1) // # + 8 字符
  })

  it('label 含片段 + 首消息预览', () => {
    const c = toCandidate(makeMatchedSession({ firstMessagePreview: '修复登录 bug' }))
    expect(c.label).toContain('019e6c96')
    expect(c.label).toContain('修复登录 bug')
  })

  it('无 firstMessagePreview → label 标 (无预览)', () => {
    const c = toCandidate(makeMatchedSession({ firstMessagePreview: undefined }))
    expect(c.label).toContain('(无预览)')
  })

  it('label 预览超长截断', () => {
    const c = toCandidate(makeMatchedSession({ firstMessagePreview: 'X'.repeat(200) }))
    // label = "frag " + 截断预览；截断预览 ≤ 40 + …
    expect(c.label.length).toBeLessThan(60)
    expect(c.label).toContain('…')
  })

  it('description 是相对时间', () => {
    const c = toCandidate(makeMatchedSession({ mtime: Date.now() - 7_200_000 }))
    expect(c.description).toBe('2 小时前')
  })
})

// ---- provideHashCandidates（端到端，真实 tmpdir）----

describe('provideHashCandidates', () => {
  let agentDir: string
  let slugDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'hash-test-'))
    slugDir = join(agentDir, 'sessions', '--Users-demo--')
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  it('非 # 输入 → null（委托下家 provider）', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    const result = await provideHashCandidates('hello world', agentDir)
    expect(result).toBeNull()
  })

  it('# 空片段 → recent 候选（最近 session）', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    await makeSession(slugDir, { name: 'b.jsonl', id: '019fffff-cccc-dddd', cwd: '/demo' })
    const result = await provideHashCandidates('#', agentDir)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(2)
  })

  it('#e6c9 片段 → findSessions("e6c9") 候选', async () => {
    await makeSession(slugDir, {
      name: 'a.jsonl',
      id: '019e6c96-aaaa-bbbb',
      cwd: '/demo',
      firstUserText: '修复登录 bug',
    })
    await makeSession(slugDir, {
      name: 'b.jsonl',
      id: '019fffff-cccc-dddd',
      cwd: '/demo',
      firstUserText: '无关内容',
    })
    const result = await provideHashCandidates('#e6c9', agentDir)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(1)
    // 命中的是 sessionId 含 e6c9 的那个
    expect(result![0].insertText).toBe('#019e6c96')
    expect(result![0].label).toContain('修复登录 bug')
  })

  it('insertText 格式 #xxxxxxxx（8 字符片段）', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    const result = await provideHashCandidates('#019e', agentDir)
    expect(result).not.toBeNull()
    const c = result![0] as AutocompleteCandidate
    expect(c.insertText).toMatch(/^#[0-9a-f]{8}$/i)
    expect(c.insertText).toBe('#019e6c96')
  })

  it('# 片段无匹配 → 空数组（不抛）', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    // deadbeef 全十六进制但无匹配 → uuid 特征短路，返回空（findSessions 语义）
    const result = await provideHashCandidates('#deadbeef', agentDir)
    expect(result).not.toBeNull()
    expect(result).toEqual([])
  })

  it('limit 限制返回数量', async () => {
    // 5 个 session id 都含 hex 片段 '019e6c9'（# 只认 uuid 片段，id 用 hex）
    for (let i = 0; i < 5; i++) {
      await makeSession(slugDir, { name: `f${i}.jsonl`, id: `019e6c9${i}-aaaa-bbbb`, cwd: '/demo' })
    }
    const result = await provideHashCandidates('#019e6c9', agentDir, { limit: 2 })
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(2)
  })
})
