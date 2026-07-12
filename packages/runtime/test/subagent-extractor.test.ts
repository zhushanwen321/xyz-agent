import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeCwd } from '../src/infra/pi/pi-paths.js'

// mock getSubagentSessionDir 让回退查找测试用临时目录
const mockSubagentDir = { dir: '' }
vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSubagentSessionDir: () => mockSubagentDir.dir,
  }
})

import { extractSubagentsFromSessionFile } from '../src/services/session/subagent-extractor.js'

describe('encodeCwd', () => {
  it('encodes Unix cwd path correctly', () => {
    expect(encodeCwd('/Users/x/proj')).toBe('--Users-x-proj--')
  })

  it('encodes Windows cwd path correctly', () => {
    // C:\Users\x\proj → 去首斜杠（首字符 C 不匹配）→ : 和 \ 都替换为 - → C--Users-x-proj
    expect(encodeCwd('C:\\Users\\x\\proj')).toBe('--C--Users-x-proj--')
  })

  it('encodes path with colon', () => {
    expect(encodeCwd('/a:b/c')).toBe('--a-b-c--')
  })
})

describe('extractSubagentsFromSessionFile', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('extracts sync subagent record from session JSONL', () => {
    const sessionFile = join(tempDir, 'main-session.jsonl')
    const subagentSessionFile = '/data/subagents/sessions/sub1.jsonl'

    const toolCallId = 'call_abc123'
    const entries = [
      { type: 'session', id: 'main-1', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        timestamp: '2026-07-10T10:01:00Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: {
                  agent: 'reviewer',
                  task: 'Review the plan document',
                  wait: true,
                },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        timestamp: '2026-07-10T10:04:00Z',
        message: {
          role: 'toolResult',
          toolCallId: toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'run-xxx-1',
                sessionFile: subagentSessionFile,
                syncResponse: {
                  status: 'done',
                  mode: 'sync',
                  agent: 'reviewer',
                  model: 'zai-router/glm-5.2',
                  turns: 15,
                  totalTokens: 667979,
                  elapsedSeconds: 194,
                  result: 'Review complete',
                },
              }),
            },
          ],
        },
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)

    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.subagentId).toBe('run-xxx-1')
    expect(r.agent).toBe('reviewer')
    expect(r.status).toBe('done')
    expect(r.mode).toBe('sync')
    expect(r.turns).toBe(15)
    expect(r.totalTokens).toBe(667979)
    expect(r.elapsedSeconds).toBe(194)
    expect(r.sessionFile).toBe(subagentSessionFile)
    expect(r.task).toBe('Review the plan document')
  })

  it('extracts background subagent with bg-notify status update', () => {
    const sessionFile = join(tempDir, 'bg-session.jsonl')
    const subagentSessionFile = '/data/subagents/sessions/bg1.jsonl'
    const bgSubagentId = 'bg-xxx-1-1234567890'

    const toolCallId = 'call_bg1'
    const entries = [
      { type: 'session', id: 'main-2', cwd: '/proj', timestamp: '2026-07-11T06:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        timestamp: '2026-07-11T06:38:29Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: toolCallId,
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: {
                  agent: 'worker',
                  task: 'Modify gate.ts',
                  wait: false,
                },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        timestamp: '2026-07-11T06:38:30Z',
        message: {
          role: 'toolResult',
          toolCallId: toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: bgSubagentId,
                sessionFile: null,
                bgResponse: {
                  status: 'running',
                  mode: 'background',
                  message: 'detached, will notify on completion',
                },
              }),
            },
          ],
        },
      },
      // list response updates sessionFile + status
      {
        type: 'message',
        id: 'msg-3',
        timestamp: '2026-07-11T06:40:00Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_list1',
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'list',
                subagentId: null,
                sessionFile: null,
                listResponse: {
                  running: 1,
                  items: [
                    {
                      subagentId: bgSubagentId,
                      agent: 'worker',
                      status: 'running',
                      mode: 'background',
                      sessionFile: subagentSessionFile,
                      model: 'mimo-router/mimo-v2.5-pro',
                      totalTokens: 567852,
                      duration: 86,
                    },
                  ],
                },
              }),
            },
          ],
        },
      },
      // bg-notify marks as done
      {
        type: 'custom_message',
        customType: 'subagent-bg-notify',
        content: 'Subagent "worker" completed.',
        details: {
          id: bgSubagentId,
          status: 'done',
          agent: 'worker',
          model: 'mimo-router/mimo-v2.5-pro',
          startedAt: 1783751909029,
          endedAt: 1783752218705,
        },
        timestamp: '2026-07-11T07:03:38Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)

    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.subagentId).toBe(bgSubagentId)
    expect(r.mode).toBe('background')
    expect(r.status).toBe('done')
    expect(r.sessionFile).toBe(subagentSessionFile)
    expect(r.agent).toBe('worker')
    expect(r.totalTokens).toBe(567852)
    expect(r.elapsedSeconds).toBe(86)
    expect(r.startedAt).toBe(1783751909029)
    expect(r.endedAt).toBe(1783752218705)
  })

  it('returns empty array for file with no subagent calls', () => {
    const sessionFile = join(tempDir, 'no-subagent.jsonl')
    const entries = [
      { type: 'session', id: 'main-3', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there' }],
        },
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(0)
  })

  it('returns empty array for non-existent file', () => {
    const records = extractSubagentsFromSessionFile('/nonexistent/path/file.jsonl')
    expect(records).toHaveLength(0)
  })

  it('handles failed sync subagent', () => {
    const sessionFile = join(tempDir, 'failed-sync.jsonl')
    const toolCallId = 'call_fail1'

    const entries = [
      { type: 'session', id: 'main-4', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
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
          toolCallId: toolCallId,
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'run-fail-1',
                sessionFile: '/data/sub/sf.jsonl',
                syncResponse: {
                  status: 'failed',
                  mode: 'sync',
                  agent: 'reviewer',
                  error: 'Model timeout',
                  turns: 3,
                  totalTokens: 5000,
                  elapsedSeconds: 30,
                },
              }),
            },
          ],
        },
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('failed')
    expect(records[0].error).toBe('Model timeout')
    expect(records[0].turns).toBe(3)
  })

  it('extracts multiple sync subagents', () => {
    const sessionFile = join(tempDir, 'multi-sync.jsonl')

    const entries = [
      { type: 'session', id: 'main-5', cwd: '/proj', timestamp: '2026-07-10T10:00:00Z' },
      // first subagent
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_a',
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'reviewer', task: 'Task A', wait: true },
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
          toolCallId: 'call_a',
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'run-a-1',
                sessionFile: '/data/a.jsonl',
                syncResponse: { status: 'done', mode: 'sync', agent: 'reviewer', turns: 5, totalTokens: 10000, elapsedSeconds: 60 },
              }),
            },
          ],
        },
      },
      // second subagent
      {
        type: 'message',
        id: 'msg-3',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_b',
              name: 'subagent',
              arguments: {
                action: 'start',
                startParam: { agent: 'general-purpose', task: 'Task B', wait: true },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'msg-4',
        message: {
          role: 'toolResult',
          toolCallId: 'call_b',
          toolName: 'subagent',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'start',
                subagentId: 'run-b-2',
                sessionFile: '/data/b.jsonl',
                syncResponse: { status: 'done', mode: 'sync', agent: 'general-purpose', turns: 10, totalTokens: 20000, elapsedSeconds: 120 },
              }),
            },
          ],
        },
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(2)
    expect(records[0].subagentId).toBe('run-a-1')
    expect(records[0].agent).toBe('reviewer')
    expect(records[1].subagentId).toBe('run-b-2')
    expect(records[1].agent).toBe('general-purpose')
  })
})

describe('extractSubagentsFromSessionFile — background sessionFile 回退查找', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'subagent-fallback-'))
    mockSubagentDir.dir = join(tempDir, 'subagents-sessions')
    mkdirSync(mockSubagentDir.dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    mockSubagentDir.dir = ''
  })

  it('sessionFile=null 时用 startedAt 时间戳匹配 subagent JSONL 文件', () => {
    const sessionFile = join(tempDir, 'bg-no-sessionfile.jsonl')
    const subagentJsonl = join(mockSubagentDir.dir, '2026-07-12T17-09-01-293Z_019f574d-c0ed.jsonl')
    writeFileSync(subagentJsonl, JSON.stringify({ type: 'session', id: 'sub-1', cwd: '/proj', timestamp: '2026-07-12T17:09:01Z' }) + '\n')

    const bgSubagentId = 'bg-fallback-1-1783876141075'
    const toolCallId = 'call_fb1'
    const entries = [
      { type: 'session', id: 'main-fb', cwd: '/proj', timestamp: '2026-07-12T17:08:53Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall', id: toolCallId, name: 'subagent',
            arguments: { action: 'start', startParam: { agent: 'general-purpose', task: 'Scan directory', wait: false } },
          }],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult', toolCallId, toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({
            action: 'start', subagentId: bgSubagentId, sessionFile: null,
            bgResponse: { status: 'running', mode: 'background', message: 'detached' },
          }) }],
        },
      },
      {
        type: 'custom_message',
        customType: 'subagent-bg-notify',
        content: 'Subagent completed.',
        details: {
          id: bgSubagentId, status: 'done', agent: 'general-purpose',
          model: 'test/model', startedAt: 1783876141075, endedAt: 1783876149814,
        },
        timestamp: '2026-07-12T17:09:09Z',
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].sessionFile).not.toBeNull()
    expect(records[0].sessionFile).toBe(subagentJsonl)
    expect(records[0].status).toBe('done')
  })

  it('目录不存在时 sessionFile 保持 null', () => {
    const sessionFile = join(tempDir, 'no-dir.jsonl')
    mockSubagentDir.dir = join(tempDir, 'nonexistent-dir')

    const bgSubagentId = 'bg-nodir-1'
    const toolCallId = 'call_nd1'
    const entries = [
      { type: 'session', id: 'main-nd', cwd: '/proj', timestamp: '2026-07-12T17:08:53Z' },
      {
        type: 'message',
        id: 'msg-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'toolCall', id: toolCallId, name: 'subagent',
            arguments: { action: 'start', startParam: { agent: 'worker', task: 'Do stuff', wait: false } },
          }],
        },
      },
      {
        type: 'message',
        id: 'msg-2',
        message: {
          role: 'toolResult', toolCallId, toolName: 'subagent',
          content: [{ type: 'text', text: JSON.stringify({
            action: 'start', subagentId: bgSubagentId, sessionFile: null,
            bgResponse: { status: 'running', mode: 'background', message: 'detached' },
          }) }],
        },
      },
    ]

    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n'))

    const records = extractSubagentsFromSessionFile(sessionFile)
    expect(records).toHaveLength(1)
    expect(records[0].sessionFile).toBeNull()
  })
})
