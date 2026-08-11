import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { listMainSessions, listSubagentSessions } from '../discovery/roots.js'

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
