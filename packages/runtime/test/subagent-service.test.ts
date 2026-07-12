import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from '../src/services/session/session-service.js'
import { convertPiHistory } from '../src/infra/pi/message-converter.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { ScannedSessionMeta } from '../src/infra/pi/session-file-utils.js'

/**
 * W3 测试：SessionService.getSubagents + getSubagentHistory
 *
 * 用真实临时文件验证端到端链路：
 * 1. 构造主 session JSONL（含 subagent toolCall + toolResult）
 * 2. 构造 subagent JSONL（含 user + assistant message）
 * 3. mock sessionStore.scanSessions 返回主 session 元信息
 * 4. 调 getSubagents → 验证 SubagentRecord[]
 * 5. 调 getSubagentHistory → 验证 Message[]
 */

function createMockSessionStore(mainSessionFile: string, mainSessionId: string, mainCwd: string): ISessionStore {
  const meta: ScannedSessionMeta = {
    id: mainSessionId,
    filePath: mainSessionFile,
    cwd: mainCwd,
    timestamp: new Date().toISOString(),
    name: null,
    lastModified: Date.now(),
    size: 0,
  }
  return {
    scanSessions: () => [meta],
    refreshAll: () => {},
    persistSessionName: () => {},
    patchSessionCwd: () => true,
    convertHistory: (raw: unknown[]) => convertPiHistory(raw),
    trash: () => {},
  }
}

/** Minimal pm mock — SessionService 构造函数需要 onSessionExit */
function createMockPm() {
  return {
    onSessionExit: () => {},
    getClient: () => undefined,
    hasClient: () => false,
  }
}

describe('SessionService.getSubagents', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-svc-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('extracts subagent list from main session JSONL', async () => {
    const mainSessionFile = join(tempDir, 'main.jsonl')
    const subagentFile = join(tempDir, 'sub1.jsonl')
    const toolCallId = 'call_test1'

    // 主 session JSONL（含一个 sync subagent）
    const mainEntries = [
      { type: 'session', id: 'main-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'reviewer', task: 'Review code', wait: true },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult',
          toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'run-test-1',
                sessionFile: subagentFile,
                syncResponse: {
                  status: 'done',
                  mode: 'sync',
                  agent: 'reviewer',
                  model: 'test/model',
                  turns: 5,
                  totalTokens: 10000,
                  elapsedSeconds: 60,
                },
              }),
            },
          ],
        },
      },
    ]
    writeFileSync(mainSessionFile, mainEntries.map((e) => JSON.stringify(e)).join('\n'))

    // subagent JSONL
    const subEntries = [
      { type: 'session', id: 'sub-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:01:00Z' },
      {
        type: 'message',
        id: 'sub-msg-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Review this code' }],
          timestamp: Date.now(),
        },
      },
      {
        type: 'message',
        id: 'sub-msg-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I have reviewed the code.' }],
          timestamp: Date.now(),
        },
      },
    ]
    writeFileSync(subagentFile, subEntries.map((e) => JSON.stringify(e)).join('\n'))

    const sessionStore = createMockSessionStore(mainSessionFile, 'main-sess-id', '/proj')
    const svc = new SessionService(
      createMockPm() as never, // pm
      {} as never, // broker
      {} as never, // adapterFactory
      '/tmp',      // projectRoot
      {} as never, // extensionService
      {} as never, // configStore
      sessionStore,
      {} as never, // gitInfoReader
      {} as never, // workspaceService
    )

    const subagents = await svc.getSubagents('main-sess-id')
    expect(subagents).toHaveLength(1)
    expect(subagents[0].subagentId).toBe('run-test-1')
    expect(subagents[0].agent).toBe('reviewer')
    expect(subagents[0].status).toBe('done')
    expect(subagents[0].sessionFile).toBe(subagentFile)
  })

  it('returns empty array for unknown session', async () => {
    const sessionStore = createMockSessionStore('/nonexistent', 'unknown', '/proj')
    const svc = new SessionService(
      createMockPm() as never, {} as never, {} as never, '/tmp', {} as never, {} as never,
      sessionStore, {} as never, {} as never,
    )

    const subagents = await svc.getSubagents('nonexistent-id')
    expect(subagents).toHaveLength(0)
  })
})

describe('SessionService.getSubagentHistory', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-hist-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('reads subagent JSONL and converts to Message[]', async () => {
    const mainSessionFile = join(tempDir, 'main.jsonl')
    const subagentFile = join(tempDir, 'subagent.jsonl')
    const toolCallId = 'call_hist1'

    // 主 session JSONL
    const mainEntries = [
      { type: 'session', id: 'main-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'reviewer', task: 'Review', wait: true },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult',
          toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'run-hist-1',
                sessionFile: subagentFile,
                syncResponse: { status: 'done', mode: 'sync', agent: 'reviewer', turns: 2, totalTokens: 5000, elapsedSeconds: 30 },
              }),
            },
          ],
        },
      },
    ]
    writeFileSync(mainSessionFile, mainEntries.map((e) => JSON.stringify(e)).join('\n'))

    // subagent JSONL（含 user + assistant 消息）
    const subEntries = [
      { type: 'session', id: 'sub-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:01:00Z' },
      {
        type: 'message',
        id: 'sub-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Please review this code file.' }],
          timestamp: Date.now(),
        },
      },
      {
        type: 'message',
        id: 'sub-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The code looks good. No issues found.' }],
          timestamp: Date.now(),
        },
      },
    ]
    writeFileSync(subagentFile, subEntries.map((e) => JSON.stringify(e)).join('\n'))

    const sessionStore = createMockSessionStore(mainSessionFile, 'main-sess-id', '/proj')
    const svc = new SessionService(
      createMockPm() as never, {} as never, {} as never, '/tmp', {} as never, {} as never,
      sessionStore, {} as never, {} as never,
    )

    const messages = await svc.getSubagentHistory('main-sess-id', 'run-hist-1')

    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages.some((m) => m.role === 'user')).toBe(true)
    expect(messages.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('returns empty array for unknown subagentId', async () => {
    const mainSessionFile = join(tempDir, 'main.jsonl')
    writeFileSync(mainSessionFile, JSON.stringify({ type: 'session', id: 'main-sess-id', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' }) + '\n')

    const sessionStore = createMockSessionStore(mainSessionFile, 'main-sess-id', '/proj')
    const svc = new SessionService(
      createMockPm() as never, {} as never, {} as never, '/tmp', {} as never, {} as never,
      sessionStore, {} as never, {} as never,
    )

    const messages = await svc.getSubagentHistory('main-sess-id', 'nonexistent-subagent')
    expect(messages).toHaveLength(0)
  })
})
