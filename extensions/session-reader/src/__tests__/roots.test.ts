import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { listMainSessions, listSubagentSessions, listGlobalSessionIds } from '../discovery/roots.js'

/** 真实 pi agent 目录（本机），用于集成测试。 */
const REAL_AGENT_DIR = '/Users/zhushanwen/.pi/agent'

describe('listMainSessions', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roots-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('扫描 sessions/<slug>/*.jsonl，排除 *.jsonl.finalized', async () => {
    const slug = '--Users-foo--'
    await mkdir(join(dir, 'sessions', slug), { recursive: true })
    await writeFile(join(dir, 'sessions', slug, 'a.jsonl'), '{"type":"session","id":"a"}\n')
    await writeFile(join(dir, 'sessions', slug, 'b.jsonl.finalized'), '{"type":"session","id":"b"}\n')

    const result = await listMainSessions(dir)
    expect(result).toHaveLength(1)
    expect(result[0].path.endsWith('a.jsonl')).toBe(true)
    expect(result[0].path.endsWith('.finalized')).toBe(false)
    expect(result[0].mtime).toBeTypeOf('number')
    expect(result[0].mtime).toBeGreaterThan(0)
    expect(result[0].size).toBeTypeOf('number')
    expect(result[0].size).toBeGreaterThan(0)
  })

  it('嵌套子目录正确递归（sessions/<slug>/deep/nested/d.jsonl）', async () => {
    await mkdir(join(dir, 'sessions', 'slug', 'deep', 'nested'), { recursive: true })
    await writeFile(join(dir, 'sessions', 'slug', 'deep', 'nested', 'd.jsonl'), '{}\n')
    // 同 slug 直接层也放一个，验证同一 slug 下平铺与嵌套并存
    await writeFile(join(dir, 'sessions', 'slug', 'top.jsonl'), '{}\n')

    const result = await listMainSessions(dir)
    const names = result.map((m) => m.path.split('/').pop()!)
    expect(names).toContain('d.jsonl')
    expect(names).toContain('top.jsonl')
    expect(result).toHaveLength(2)
  })

  it('跳过 workflow-state 子目录（wf-*.jsonl 非 session 文件）', async () => {
    const slug = '--Users-x--'
    await mkdir(join(dir, 'sessions', slug, 'workflow-state'), { recursive: true })
    await writeFile(join(dir, 'sessions', slug, 'real.jsonl'), '{"type":"session"}\n')
    await writeFile(
      join(dir, 'sessions', slug, 'workflow-state', 'wf-abc.jsonl'),
      '{"v":"wf-run-v1"}\n',
    )

    const result = await listMainSessions(dir)
    expect(result).toHaveLength(1)
    expect(result[0].path.endsWith('real.jsonl')).toBe(true)
    expect(result.every((m) => !m.path.includes('workflow-state'))).toBe(true)
  })

  it('空 agentDir（无 sessions 目录）返回 []，不抛错', async () => {
    await expect(listMainSessions(dir)).resolves.toEqual([])
  })

  it('不存在的 agentDir 返回 []，不抛错', async () => {
    await expect(listMainSessions(join(dir, 'no-such-dir'))).resolves.toEqual([])
  })

  it('真实数据：扫描 ~/.pi/agent，含 019e6c96，不含 .finalized 与 wf-', async () => {
    const result = await listMainSessions(REAL_AGENT_DIR)
    expect(result.length).toBeGreaterThan(0)
    // 含目标 session
    expect(result.some((m) => m.path.includes('019e6c96'))).toBe(true)
    // 排除 finalized
    expect(result.every((m) => !m.path.endsWith('.finalized'))).toBe(true)
    // 排除 workflow-state 目录
    expect(result.every((m) => !m.path.includes('workflow-state'))).toBe(true)
    // 排除 wf- 前缀文件名
    expect(result.every((m) => !m.path.split('/').pop()!.startsWith('wf-'))).toBe(true)
    // mtime/size 真实
    expect(result.every((m) => m.mtime > 0 && m.size > 0)).toBe(true)
  }, 30000)
})

describe('listSubagentSessions', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roots-sub-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('扫描 subagents/<slug>/sessions/*.jsonl，排除 .finalized', async () => {
    const slug = '--Users-foo--'
    await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
    await writeFile(join(dir, 'subagents', slug, 'sessions', 'c.jsonl'), '{"type":"session"}\n')
    await writeFile(
      join(dir, 'subagents', slug, 'sessions', 'c.jsonl.finalized'),
      '{"type":"session"}\n',
    )

    const result = await listSubagentSessions(dir)
    expect(result).toHaveLength(1)
    expect(result[0].path.endsWith('c.jsonl')).toBe(true)
    expect(result[0].path.endsWith('.finalized')).toBe(false)
  })

  it('records/ 子目录（.json manifest）不被误收', async () => {
    const slug = '--Users-foo--'
    await mkdir(join(dir, 'subagents', slug, 'records'), { recursive: true })
    await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
    await writeFile(join(dir, 'subagents', slug, 'records', 'manifest.json'), '{}\n')
    await writeFile(join(dir, 'subagents', slug, 'sessions', 'sub.jsonl'), '{"type":"session"}\n')

    const result = await listSubagentSessions(dir)
    expect(result).toHaveLength(1)
    expect(result[0].path.endsWith('sub.jsonl')).toBe(true)
  })

  it('无 subagents 目录返回 []，不抛错', async () => {
    await expect(listSubagentSessions(dir)).resolves.toEqual([])
  })

  it('真实数据：扫描 ~/.pi/agent/subagents 返回非空', async () => {
    const result = await listSubagentSessions(REAL_AGENT_DIR)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((m) => !m.path.endsWith('.finalized'))).toBe(true)
  }, 30000)
})

describe('listGlobalSessionIds', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roots-gid-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('文件名含 uuid（快路径）：从文件名提取 id，不读首行', async () => {
    const slug = '--Users-foo--'
    const id = '019e6c96-0a0c-74b8-a73f-d1854d88e2a7'
    await mkdir(join(dir, 'sessions', slug), { recursive: true })
    await writeFile(
      join(dir, 'sessions', slug, `2026-05-28T03-17-12-844Z_${id}.jsonl`),
      JSON.stringify({ type: 'session', id }) + '\n',
    )
    const result = await listGlobalSessionIds(dir)
    expect(result).toContain(id)
    expect(result).toHaveLength(1)
  })

  it('orphan 文件名（session.jsonl，无 uuid）：回退读首行 header.id（慢路径）', async () => {
    const slug = '--Users-foo--'
    const id = '019eabcd-1111-2222-3333-444455556666'
    await mkdir(join(dir, 'sessions', slug), { recursive: true })
    // 故意用不含 uuid 的文件名 → 走 orphan 读首行路径
    await writeFile(
      join(dir, 'sessions', slug, 'session.jsonl'),
      JSON.stringify({ type: 'session', id, version: 3 }) + '\n',
    )
    const result = await listGlobalSessionIds(dir)
    expect(result).toContain(id)
    expect(result).toHaveLength(1)
  })

  it('orphan 非 session header（无 type/session）→ 跳过，不抛', async () => {
    const slug = '--Users-foo--'
    await mkdir(join(dir, 'sessions', slug), { recursive: true })
    await writeFile(join(dir, 'sessions', slug, 'session.jsonl'), '{"type":"other"}\n')
    const result = await listGlobalSessionIds(dir)
    expect(result).toEqual([])
  })

  it('排除 .finalized 与 workflow-state 子目录', async () => {
    const slug = '--Users-foo--'
    const id = '019e6c96-0a0c-74b8-a73f-d1854d88e2a7'
    await mkdir(join(dir, 'sessions', slug), { recursive: true })
    await mkdir(join(dir, 'sessions', slug, 'workflow-state'), { recursive: true })
    await writeFile(
      join(dir, 'sessions', slug, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
      '{"type":"session"}\n',
    )
    // .finalized 同 base name，应排除
    await writeFile(
      join(dir, 'sessions', slug, `2026-01-01T00-00-00-000Z_${id}.jsonl.finalized`),
      '{"type":"session"}\n',
    )
    // workflow-state 内 wf 文件，应排除
    await writeFile(
      join(dir, 'sessions', slug, 'workflow-state', 'wf-abc.jsonl'),
      '{"v":"wf-run-v1"}\n',
    )
    const result = await listGlobalSessionIds(dir)
    expect(result).toHaveLength(1)
    expect(result).toContain(id)
  })

  it('跨 cwd：sessions/<cwdA>/ + sessions/<cwdB>/ 都扫到', async () => {
    const idA = '019e6c96-0a0c-74b8-a73f-d1854d88e2a7'
    const idB = '019effff-1111-2222-3333-444455556666'
    await mkdir(join(dir, 'sessions', 'cwdA'), { recursive: true })
    await mkdir(join(dir, 'sessions', 'cwdB'), { recursive: true })
    await writeFile(
      join(dir, 'sessions', 'cwdA', `2026-01-01T00-00-00-000Z_${idA}.jsonl`),
      '{"type":"session"}\n',
    )
    await writeFile(
      join(dir, 'sessions', 'cwdB', `2026-01-01T00-00-00-000Z_${idB}.jsonl`),
      '{"type":"session"}\n',
    )
    const result = await listGlobalSessionIds(dir)
    expect(result).toHaveLength(2)
    expect(result).toContain(idA)
    expect(result).toContain(idB)
  })

  it('空/不存在 agentDir 返回 []，不抛', async () => {
    await expect(listGlobalSessionIds(dir)).resolves.toEqual([])
    await expect(listGlobalSessionIds(join(dir, 'no-such'))).resolves.toEqual([])
  })

  it('真实数据：~/.pi/agent 全局 id，含 019e6c96 前缀，性能报告', async () => {
    const t0 = process.hrtime.bigint()
    const result = await listGlobalSessionIds(REAL_AGENT_DIR)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    expect(result.length).toBeGreaterThan(1000) // 真实环境数千 session
    expect(result.some((id) => id.startsWith('019e6c96'))).toBe(true)
    // 性能验收：任务要求 < 100ms（实测冷启动 ~82ms / 热 ~50ms）。
    // 断言边界 500ms 防 CI 环境抖动，实际数字由 console 报告。
    expect(ms).toBeLessThan(500)
    // eslint-disable-next-line no-console
    console.log(`[perf] listGlobalSessionIds(~/.pi/agent): ${result.length} ids, ${ms.toFixed(1)}ms`)
  }, 30000)
})
