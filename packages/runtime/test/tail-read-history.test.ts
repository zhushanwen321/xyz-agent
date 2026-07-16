/**
 * W1 红灯测试：tailReadHistory 尾读 + turn 边界截断。
 *
 * 对应 FR-3（tailReadHistory）+ AC-5/6/12/13。
 *
 * turn 定义（D11）：user message 到下一个 user message 之前（含其间的 assistant + tool_call + toolResult）。
 * tailReadHistory 从文件尾部倒扫，收集最近 maxTurns=20 个完整 turn，保证 assistant↔toolResult 配对完整。
 *
 * 核心防的 bug：
 * - AC-5：尾读返回的消息里 toolResult 必须能配对到 assistant（不能有孤立 toolResult）
 * - AC-6：文件不存在返回空数组不抛（pi 延迟写入）
 * - AC-12：文件末行损坏（JSON 不完整）不抛（复用 INVAR-tail-3 残行丢弃）
 * - turn 边界：不能截断在 turn 中间（如取到 toolResult 但丢了对应 assistant tool_call）
 *
 * [红灯说明] tailReadHistory 尚未实现，import 会 fail（模块导出不存在）。
 *
 * 运行：cd packages/runtime && npx vitest run test/tail-read-history.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { tailReadHistory } from '../src/services/session-history.js'
import type { ISessionStore } from '../src/services/ports/session.js'

/**
 * mock sessionStore：convertHistory 透传 piMessages（不合并 toolResult），
 * 让测试能验证 tailReadHistory 的 turn 边界 + 配对完整性（转换前的原始数据）。
 */
function makePassthroughStore(): ISessionStore {
  return {
    scanSessions: () => [],
    convertHistory: (piMessages) => piMessages as never,
  } as unknown as ISessionStore
}

describe('W1 tailReadHistory 尾读 + turn 边界截断', () => {
  let tmpDir: string
  let store: ISessionStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tail-read-'))
    store = makePassthroughStore()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 构造一个 pi JSONL session 文件 */
  function writeSessionFile(lines: string[]): string {
    const filePath = join(tmpDir, 'session.jsonl')
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    return filePath
  }

  /** 造一个 user turn（user message + assistant with tool_call + toolResult） */
  function makeTurn(turnIdx: number): string[] {
    return [
      JSON.stringify({ type: 'message', id: `u-${turnIdx}`, message: { role: 'user', content: `user-${turnIdx}` } }),
      JSON.stringify({ type: 'message', id: `a-${turnIdx}`, message: { role: 'assistant', content: `assistant-${turnIdx}`, toolCalls: [{ id: `tc-${turnIdx}`, toolName: 'read', input: {} }] } }),
      JSON.stringify({ type: 'message', id: `tr-${turnIdx}`, message: { role: 'toolResult', toolCallId: `tc-${turnIdx}`, content: `result-${turnIdx}` } }),
    ]
  }

  it('AC-5: 加载最近 turn，toolResult 都能配对到 assistant（无孤立 toolResult）', async () => {
    // 造 25 个 turn（超过 maxTurns=20）
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    for (let i = 0; i < 25; i++) {
      lines.push(...makeTurn(i))
    }
    const filePath = writeSessionFile(lines)

    const messages = await tailReadHistory(filePath, store, 20)

    // 应加载最近 20 turn（每个 turn 3 条 message = 60 条）
    expect(messages.length).toBe(60)

    // AC-5 核心：每条 toolResult 都能配对到 assistant
    const assistantToolCallIds = new Set<string>()
    for (const msg of messages) {
      const m = msg as { role?: string; toolCalls?: { id: string }[] }
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) assistantToolCallIds.add(tc.id)
      }
    }
    for (const msg of messages) {
      const m = msg as { role?: string; toolCallId?: string }
      if (m.role === 'toolResult') {
        expect(assistantToolCallIds.has(m.toolCallId!)).toBe(true)
      }
    }
  })

  it('AC-5 边界：加载的 turn 数不超过 maxTurns', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    for (let i = 0; i < 30; i++) {
      lines.push(...makeTurn(i))
    }
    const filePath = writeSessionFile(lines)

    const messages5 = await tailReadHistory(filePath, store, 5)
    // 5 turn × 3 message = 15 条（不含 session header）
    expect(messages5.length).toBeLessThanOrEqual(15)
  })

  it('AC-6: 文件不存在返回空数组不抛', async () => {
    const noExist = join(tmpDir, 'never-exists.jsonl')
    await expect(tailReadHistory(noExist, store, 20)).resolves.toEqual([])
  })

  it('AC-12: 文件末行损坏（JSON 不完整）不抛异常', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      ...makeTurn(0),
    ]
    // 末行追加一个损坏的 JSON 片段（被切断）
    const filePath = join(tmpDir, 'session.jsonl')
    writeFileSync(filePath, lines.join('\n') + '\n' + '{"type":"message","id":"broken","message":{', 'utf-8')

    const messages = await tailReadHistory(filePath, store, 20)
    // 损坏行被跳过，正常 turn 的消息仍加载
    expect(messages.length).toBeGreaterThan(0)
  })

  it('turn 边界对齐：不截断在 turn 中间（取到 toolResult 不丢 assistant）', async () => {
    // 构造 22 个 turn，验证尾部第一个 turn 的 assistant 也被加载（不只有 toolResult）
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
    ]
    for (let i = 0; i < 22; i++) {
      lines.push(...makeTurn(i))
    }
    const filePath = writeSessionFile(lines)

    const messages = await tailReadHistory(filePath, store, 20)
    // 验证 turn 2（第 3 个 turn，索引从 0 计：0..21，取尾部 2..21）的 assistant 在结果里
    const hasTurn2Assistant = messages.some(
      (m) => (m as { role?: string; content?: string }).role === 'assistant' && (m as { content?: string }).content === 'assistant-2',
    )
    expect(hasTurn2Assistant).toBe(true)
    // turn 1（被截掉的）的 assistant 不应在结果里
    const hasTurn1Assistant = messages.some(
      (m) => (m as { role?: string; content?: string }).role === 'assistant' && (m as { content?: string }).content === 'assistant-1',
    )
    expect(hasTurn1Assistant).toBe(false)
  })

  it('小文件（< 20 turn）加载全部', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      ...makeTurn(0),
      ...makeTurn(1),
    ]
    const filePath = writeSessionFile(lines)

    const messages = await tailReadHistory(filePath, store, 20)
    // 2 turn × 3 message = 6 条
    expect(messages.length).toBe(6)
  })

  it('compaction/custom_message entry 也被保留（规则 #7.5 可重开恢复）', async () => {
    const lines: string[] = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'compaction', summary: '压缩摘要', tokensBefore: 10000, timestamp: '2025-01-01T00:00:01Z' }),
      JSON.stringify({ type: 'custom_message', customType: 'subagent-bg-notify', content: '通知内容', timestamp: '2025-01-01T00:00:02Z' }),
      ...makeTurn(0),
    ]
    const filePath = writeSessionFile(lines)

    const messages = await tailReadHistory(filePath, store, 20)
    // compaction + custom_message + 1 turn(3条) = 5 条
    expect(messages.length).toBe(5)
    const types = messages.map((m) => (m as { role?: string }).role)
    expect(types).toContain('compactionSummary')
    expect(types).toContain('custom')
  })
})
