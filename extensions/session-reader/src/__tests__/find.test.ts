import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { findSessions } from '../discovery/find.js'
import { REAL_AGENT_DIR, HAS_E6 } from './real-data.js'

/**
 * 建一个假 session 文件：首行 header（type=session，含 id/cwd/parentSession），
 * 可选第二条 user message（用于名称关键词匹配 + firstMessagePreview）。返回绝对路径。
 */
async function makeSession(
  dir: string,
  opts: {
    name: string
    id: string
    cwd?: string
    parentSession?: string
    firstUserText?: string
  },
): Promise<string> {
  const header: Record<string, unknown> = {
    type: 'session',
    id: opts.id,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
  if (opts.cwd) header.cwd = opts.cwd
  if (opts.parentSession) header.parentSession = opts.parentSession
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

describe('findSessions', () => {
  let agentDir: string
  let slugDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'find-test-'))
    slugDir = join(agentDir, 'sessions', '--Users-demo--')
  })
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  it('uuid 片段匹配正确的 session（sessionId 含 query）', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: '019e6c96-aaaa-bbbb', cwd: '/demo' })
    await makeSession(slugDir, { name: 'b.jsonl', id: '019fffff-cccc-dddd', cwd: '/demo' })

    const { matches } = await findSessions('e6c96', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('019e6c96-aaaa-bbbb')
  })

  it('uuid 片段匹配：文件路径含 query（query 出现在文件名）', async () => {
    // sessionId 不含 query，但文件名含 → path.includes(query) 命中
    await makeSession(slugDir, { name: '2026-special-name.jsonl', id: 'sid-no-query', cwd: '/demo' })
    const { matches } = await findSessions('special', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('sid-no-query')
  })

  it('fileName 填完整绝对路径，mtime/sizeBytes/cwd 为真实值', async () => {
    const path = await makeSession(slugDir, { name: 'a.jsonl', id: 'sid-fullpath', cwd: '/demo' })
    const { matches } = await findSessions('sid-fullpath', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].fileName).toBe(path)
    expect(matches[0].mtime).toBeGreaterThan(0)
    expect(matches[0].sizeBytes).toBeGreaterThan(0)
    expect(matches[0].cwd).toBe('/demo')
  })

  it('cwd 过滤：只留 header.cwd === opts.cwd 的', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: 'aaa-shared', cwd: '/proj-a' })
    await makeSession(slugDir, { name: 'b.jsonl', id: 'bbb-shared', cwd: '/proj-b' })

    // query 'shared' 同时命中两个 id，cwd 过滤后只留 /proj-a
    const { matches } = await findSessions('shared', agentDir, { cwd: '/proj-a' })
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('aaa-shared')
    expect(matches[0].cwd).toBe('/proj-a')
  })

  it('limit 截断：truncated 标记正确', async () => {
    // 5 个文件 id 都含 "common"，uuid 片段 "common" 全匹配
    for (let i = 0; i < 5; i++) {
      await makeSession(slugDir, { name: `f${i}.jsonl`, id: `common-${i}`, cwd: '/demo' })
    }
    const { matches, truncated } = await findSessions('common', agentDir, { limit: 2 })
    expect(matches).toHaveLength(2)
    expect(truncated).toBe(true)

    // limit >= 总数时 truncated=false
    const all = await findSessions('common', agentDir, { limit: 10 })
    expect(all.matches).toHaveLength(5)
    expect(all.truncated).toBe(false)
  })

  it("query='recent' 按 mtime 倒序", async () => {
    const paths: string[] = []
    for (let i = 0; i < 3; i++) {
      paths.push(await makeSession(slugDir, { name: `r${i}.jsonl`, id: `recent-${i}`, cwd: '/demo' }))
    }
    // 设递增 mtime：r0 最旧，r2 最新
    const base = Math.floor(Date.now() / 1000)
    await utimes(paths[0], base, base)
    await utimes(paths[1], base + 100, base + 100)
    await utimes(paths[2], base + 200, base + 200)

    const { matches } = await findSessions('recent', agentDir)
    expect(matches).toHaveLength(3)
    expect(matches[0].sessionId).toBe('recent-2') // mtime 最大排前
    expect(matches[1].sessionId).toBe('recent-1')
    expect(matches[2].sessionId).toBe('recent-0')
  })

  it("recent 也尊重 cwd 过滤", async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: 'r-a', cwd: '/proj-a' })
    await makeSession(slugDir, { name: 'b.jsonl', id: 'r-b', cwd: '/proj-b' })

    const { matches } = await findSessions('recent', agentDir, { cwd: '/proj-a' })
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('r-a')
  })

  it('名称关键词匹配：uuid 无匹配时读首消息预览含 query', async () => {
    // query 'plugin' 含 p/l/u/g/i/n（p/l/u 非十六进制）→ 非 uuid 特征，走首消息 fallback
    await makeSession(slugDir, {
      name: 'a.jsonl',
      id: 'kw-aaaa',
      cwd: '/demo',
      firstUserText: '重构插件架构 plugin architecture review',
    })
    await makeSession(slugDir, {
      name: 'b.jsonl',
      id: 'kw-bbbb',
      cwd: '/demo',
      firstUserText: '完全无关的内容 unrelated content',
    })

    const { matches } = await findSessions('plugin', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].sessionId).toBe('kw-aaaa')
    expect(matches[0].firstMessagePreview).toContain('plugin')
  })

  it('无匹配返回 { matches: [], truncated: false }', async () => {
    await makeSession(slugDir, { name: 'a.jsonl', id: '019abcd', cwd: '/demo' })
    // query 非 uuid 特征（z 非十六进制），走首消息 fallback 仍无匹配
    const result = await findSessions('zzznotexist', agentDir)
    expect(result).toEqual({ matches: [], truncated: false })
  })

  it('firstMessagePreview 截断到 80 字符', async () => {
    const longText = 'X'.repeat(200)
    await makeSession(slugDir, {
      name: 'a.jsonl',
      id: 'prev-len',
      cwd: '/demo',
      firstUserText: longText,
    })
    const { matches } = await findSessions('prev-len', agentDir)
    expect(matches).toHaveLength(1)
    expect(matches[0].firstMessagePreview).toBeDefined()
    expect(matches[0].firstMessagePreview!.length).toBeLessThanOrEqual(80)
  })

  it('纯十六进制 query 无 uuid 匹配时不走首消息 fallback（uuid 特征短路）', async () => {
    // 'deadbeef' 全十六进制 → uuid 特征；sessionId 不含、首消息也不会含 → matched=[]
    await makeSession(slugDir, {
      name: 'a.jsonl',
      id: '019aaaa',
      cwd: '/demo',
      firstUserText: 'deadbeef 出现在首消息里也不该匹配',
    })
    const result = await findSessions('deadbeef', agentDir)
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it.skipIf(!HAS_E6)('真实数据：e6c96 匹配 019e6c96 开头的 session', async () => {
    const { matches } = await findSessions('e6c96', REAL_AGENT_DIR)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some((m) => m.sessionId.startsWith('019e6c96'))).toBe(true)
    // 真实值校验
    const hit = matches.find((m) => m.sessionId.startsWith('019e6c96'))!
    expect(hit.fileName).toContain('019e6c96')
    expect(hit.mtime).toBeGreaterThan(0)
    expect(hit.sizeBytes).toBeGreaterThan(0)
  }, 30000)

  it.skipIf(!HAS_E6)("真实数据：recent 返回最近 N 个，mtime 倒序，truncated=true", async () => {
    const { matches, truncated } = await findSessions('recent', REAL_AGENT_DIR, { limit: 5 })
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.length).toBeLessThanOrEqual(5)
    // mtime 倒序
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].mtime).toBeGreaterThanOrEqual(matches[i].mtime)
    }
    // 真实 session 文件远多于 5 → 截断
    expect(truncated).toBe(true)
  }, 30000)
})
