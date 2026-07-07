/**
 * createForkedSessionFile 单测 — JSONL 截断工具（fork 路径 A 核心）。
 *
 * 覆盖：
 * - 树回溯（从 forkEntryId 沿 parentId 到 root）
 * - includeFrom=true（含 fork 点）/ false（不含）
 * - session header 重建（新 id/timestamp/parentSession 指回源）
 * - 兄弟分支丢弃（不在路径上的 entry 不写入）
 * - 边界：源文件不存在 / 无 session header / forkEntryId 找不到
 *
 * 运行：pnpm --filter @xyz-agent/runtime run test -- test/session-fork.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createForkedSessionFile } from '../src/services/session/session-fork.js'
import { parseJsonl } from '../src/utils/jsonl.js'

describe('createForkedSessionFile', () => {
  let sourceDir: string
  let targetDir: string
  let sourceFile: string

  beforeEach(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), 'fork-src-'))
    targetDir = await mkdtemp(join(tmpdir(), 'fork-tgt-'))
    sourceFile = join(sourceDir, 'source.jsonl')
  })

  afterEach(async () => {
    await Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })])
  })

  /** 构建测试 JSONL：session header + 3 turn（user/assistant/toolResult） */
  async function writeSourceJSONL(): Promise<void> {
    const lines = [
      { type: 'session', version: 3, id: 'src-session-id', timestamp: '2026-07-07T01:00:00.000Z', cwd: '/test' },
      { type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-07-07T01:00:00.100Z', provider: 'p', modelId: 'm' },
      // turn 1
      { type: 'message', id: 'u1', parentId: 'mc1', timestamp: '2026-07-07T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-07T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      // turn 2
      { type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-07-07T01:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'do work' }] } },
      { type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-07-07T01:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      // turn 3
      { type: 'message', id: 'u3', parentId: 'a2', timestamp: '2026-07-07T01:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'more' }] } },
      { type: 'message', id: 'a3', parentId: 'u3', timestamp: '2026-07-07T01:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]
    await writeFile(sourceFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  /** 读 fork 后的文件，返回解析后的 entry 数组 */
  async function readForked(filePath: string): Promise<Record<string, unknown>[]> {
    const raw = await readFile(filePath, 'utf-8')
    return parseJsonl(raw) as Record<string, unknown>[]
  }

  it('includeFrom=true：保留到 fork 点（含），兄弟分支丢弃', async () => {
    await writeSourceJSONL()
    // fork 到 a2（turn 2 assistant，含）→ 保留 u1/a1/u2/a2 + mc1，丢弃 u3/a3
    const { filePath } = await createForkedSessionFile(sourceFile, 'a2', true, targetDir)

    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)

    // session header（新 id）+ mc1 + u1 + a1 + u2 + a2
    expect(ids).toHaveLength(6)
    expect(ids).toContain('mc1')
    expect(ids).toContain('u1')
    expect(ids).toContain('a1')
    expect(ids).toContain('u2')
    expect(ids).toContain('a2')
    expect(ids).not.toContain('u3')
    expect(ids).not.toContain('a3')
  })

  it('includeFrom=false：保留到 fork 点前（不含 fork 点）', async () => {
    await writeSourceJSONL()
    // fork 到 u3（不含）→ 保留到 u3 前 = mc1/u1/a1/u2/a2，丢弃 u3/a3
    const { filePath } = await createForkedSessionFile(sourceFile, 'u3', false, targetDir)

    const entries = await readForked(filePath)
    const ids = entries.filter((e) => typeof e.id === 'string').map((e) => e.id as string)

    expect(ids).toContain('mc1')
    expect(ids).toContain('u1')
    expect(ids).toContain('a1')
    expect(ids).toContain('u2')
    expect(ids).toContain('a2')
    expect(ids).not.toContain('u3')
    expect(ids).not.toContain('a3')
  })

  it('session header 重建：新 id + parentSession 指回源文件', async () => {
    await writeSourceJSONL()
    const { filePath, sessionId } = await createForkedSessionFile(sourceFile, 'a1', true, targetDir)

    const entries = await readForked(filePath)
    const header = entries[0]
    expect(header.type).toBe('session')
    expect(header.id).toBe(sessionId) // 新 session id
    expect(header.id).not.toBe('src-session-id') // 不是源 id
    expect(header.cwd).toBe('/test') // 继承源 cwd
    expect(header.parentSession).toBe(sourceFile) // 指回源文件
  })

  it('源文件不存在时报错', async () => {
    const missing = join(sourceDir, 'no-such.jsonl')
    await expect(createForkedSessionFile(missing, 'a1', true, targetDir))
      .rejects.toThrow(/source session file not found/)
  })

  it('源文件无 session header 时报错', async () => {
    // 只有 message entry，没有 session header
    await writeFile(sourceFile, JSON.stringify({ type: 'message', id: 'x', parentId: null, message: { role: 'user', content: [] } }) + '\n')
    await expect(createForkedSessionFile(sourceFile, 'x', true, targetDir))
      .rejects.toThrow(/no valid session header/)
  })

  it('forkEntryId 在树中找不到时报错', async () => {
    await writeSourceJSONL()
    await expect(createForkedSessionFile(sourceFile, 'nonexistent-id', true, targetDir))
      .rejects.toThrow(/not found in session tree/)
  })

  it('保留 fork 点是 root 链头（mc1）时正确截断', async () => {
    await writeSourceJSONL()
    // fork 到 mc1（最早的 entry，includeFrom=true）→ 只保留 mc1（header 的 id 是新 session id，不算 entry）
    const { filePath } = await createForkedSessionFile(sourceFile, 'mc1', true, targetDir)
    const entries = await readForked(filePath)
    // 排除 session header（type==='session'），只看业务 entry id
    const ids = entries.filter((e) => e.type !== 'session' && typeof e.id === 'string').map((e) => e.id as string)
    expect(ids).toEqual(['mc1'])
  })
})
