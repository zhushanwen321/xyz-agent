/**
 * P5 分协议历史读取链单测（设计 D6 三级降级）。
 *
 * 覆盖：
 * 1. record 路由段：engine 缺省 pi（存量 record 零迁移）/ zcode / 畸形值防御
 * 2. zcode record ①→②→③ 三级降级（①真 sqlite 原生读取 ②journal 重放 ③outcome-only）
 * 3. journal 前缀白名单：越界路径（dataDir 外 / ../ 逃逸形态）拒绝且不读文件、降③级
 * 4. dbPath 越界（池目录外）拒绝①级
 * 5. pi record → 空数组（调用方走现有 JSONL 直读链的契约，A1 守护）
 *
 * engine/engineHandle 字段按并行任务契约防御式构造（shared SubagentRecord 字段由该
 * 任务写入，落地前类型上不存在——测试用交叉类型模拟写侧产物）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SUBAGENT_ENGINE,
  extractRecordEngine,
  readEngineSubagentHistory,
} from '../src/services/session/subagent-engine-history.js'
import type { SubagentRecord } from '@xyz-agent/shared'

/** 写侧契约形状（record.engine / record.engineHandle——防御式消费的镜像构造）。 */
type EngineAwareRecord = SubagentRecord & { engine?: string; engineHandle?: unknown }

interface EngineHandleShape {
  sessionRef: Record<string, string>
  journalPath?: string
  poolKey: string
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sa-engine-reader-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function zcodeRecord(handle: EngineHandleShape | undefined, engine = 'zcode'): EngineAwareRecord {
  const base: SubagentRecord = {
    subagentId: 'bg-1-test',
    sessionFile: null,
    agent: 'reviewer',
    slug: 'rev',
    task: 'review the code',
    status: 'closed',
    startedAt: 1756000000000,
    endedAt: 1756000005000,
    result: 'LGTM outcome text',
  }
  return { ...base, engine, ...(handle !== undefined ? { engineHandle: handle } : {}) }
}

const POOL_KEY = 'reviewer'
const DB_RELATIVE = '.zcode/cli/db/db.sqlite'
const SESSION_ID = 'sess-target'

/** 池目录布局与 extension 写侧同源（paths.ts SSOT 的消费镜像）。 */
function poolDir(): string {
  return join(dataDir, 'engines', 'zcode', POOL_KEY)
}

/** 建出与 zcode 0.16.5 同形的三表最小 schema（zcode reader ①级的真实读取面）。 */
async function createPoolDb(sessionId: string): Promise<void> {
  const dbFile = join(poolDir(), DB_RELATIVE)
  mkdirSync(join(dbFile, '..'), { recursive: true })
  const { DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: new (p: string) => unknown }
  type Db = {
    exec: (s: string) => void
    prepare: (s: string) => { run: (...a: unknown[]) => void }
    close: () => void
  }
  const db = new DatabaseSync(dbFile) as unknown as Db
  db.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);' +
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);' +
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);',
  )
  const insertSession = db.prepare('INSERT INTO session (id, time_created) VALUES (?, ?)')
  const insertMessage = db.prepare('INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)')
  const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)')

  insertSession.run(sessionId, 2000)
  // user prompt（不进 turns——SessionView 是 assistant 视角）
  insertMessage.run('msg_user', sessionId, 0, JSON.stringify({ role: 'user' }))
  insertPart.run('p_u', 'msg_user', sessionId, 0, JSON.stringify({ type: 'text', text: 'the task' }))

  // assistant：turn1 = reasoning + tool + step-finish(usage)，turn2 = text + step-finish(usage)
  insertMessage.run('msg_asst', sessionId, 1, JSON.stringify({ role: 'assistant' }))
  insertPart.run('p0', 'msg_asst', sessionId, 0, JSON.stringify({ type: 'step-start' }))
  insertPart.run('p1', 'msg_asst', sessionId, 1, JSON.stringify({ type: 'reasoning', text: 'thinking hard' }))
  insertPart.run(
    'p2',
    'msg_asst',
    sessionId,
    2,
    JSON.stringify({
      type: 'tool',
      tool: 'Bash',
      state: JSON.stringify({ status: 'completed', input: { command: 'ls' }, output: 'file-a' }),
    }),
  )
  insertPart.run(
    'p3',
    'msg_asst',
    sessionId,
    3,
    JSON.stringify({ type: 'step-finish', tokens: { input: 10, output: 5, cache: { read: 1, write: 2 } } }),
  )
  insertPart.run('p4', 'msg_asst', sessionId, 4, JSON.stringify({ type: 'text', text: 'done text' }))
  insertPart.run(
    'p5',
    'msg_asst',
    sessionId,
    5,
    JSON.stringify({ type: 'step-finish', tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } }),
  )
  db.close()
}

/** journal 行（extension common/event-journal.ts JournalLine v1 的写侧镜像）。 */
function journalLine(seq: number, event: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, ts: 1756000000000 + seq, taskId: 'bg-1-test', engineId: 'zcode', seq, event })
}

function writeJournal(lines: string[]): string {
  const file = join(poolDir(), 'journal-bg-1-test.jsonl')
  mkdirSync(poolDir(), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8')
  return file
}

describe('extractRecordEngine（record 路由段）', () => {
  it('routes records without engine field to pi (存量零迁移)', () => {
    const record = zcodeRecord(undefined, undefined)
    delete (record as { engine?: string }).engine
    expect(extractRecordEngine(record)).toBe('pi')
    expect(DEFAULT_SUBAGENT_ENGINE).toBe('pi')
  })

  it('routes zcode records by engine field', () => {
    expect(extractRecordEngine(zcodeRecord(undefined))).toBe('zcode')
  })

  it('treats malformed engine values as pi（防御式守卫）', () => {
    expect(extractRecordEngine(zcodeRecord(undefined, 42 as never))).toBe('pi')
    expect(extractRecordEngine(zcodeRecord(undefined, ''))).toBe('pi')
  })
})

describe('readEngineSubagentHistory（zcode 三级降级）', () => {
  it('tier1: reads native sqlite view via shared zcode reader', async () => {
    await createPoolDb(SESSION_ID)
    const messages = await readEngineSubagentHistory(
      zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, poolKey: POOL_KEY }),
      dataDir,
    )

    // user(task) + 2 个 assistant turn
    expect(messages).toHaveLength(3)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toBe('review the code')

    const [turn1, turn2] = [messages[1], messages[2]]
    expect(turn1?.role).toBe('assistant')
    expect(turn1?.thinking?.[0]?.content).toBe('thinking hard')
    expect(turn1?.toolCalls).toHaveLength(1)
    expect(turn1?.toolCalls?.[0]?.toolName).toBe('Bash')
    expect(turn1?.toolCalls?.[0]?.input).toEqual({ command: 'ls' })
    expect(turn1?.toolCalls?.[0]?.output).toBe('file-a')
    expect(turn1?.toolCalls?.[0]?.status).toBe('completed')

    expect(turn2?.content).toBe('done text')
    // SessionView.usage 聚合挂最后一个 turn：input 11 / output 6
    expect(turn2?.usage).toEqual({ inputTokens: 11, outputTokens: 6 })
  })

  it('tier2: falls back to journal replay when db is missing', async () => {
    const journalPath = writeJournal([
      journalLine(0, { type: 'text_delta', delta: 'partial ' }),
      journalLine(1, { type: 'text_delta', delta: 'answer' }),
      journalLine(2, { type: 'tool_start', toolName: 'Read', args: { path: 'a.ts' } }),
      journalLine(3, { type: 'tool_end', toolName: 'Read', result: { content: ['x'] } }),
      journalLine(4, { type: 'message_end', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } }),
      journalLine(5, { type: 'turn_end' }),
    ])

    const messages = await readEngineSubagentHistory(
      zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, journalPath, poolKey: POOL_KEY }),
      dataDir,
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.content).toBe('partial answer')
    expect(messages[1]?.toolCalls?.[0]?.toolName).toBe('Read')
    expect(messages[1]?.toolCalls?.[0]?.output).toBe('x')
    expect(messages[1]?.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
  })

  it('tier3: projects outcome-only when both db and journal are missing', async () => {
    const messages = await readEngineSubagentHistory(
      zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, poolKey: POOL_KEY }),
      dataDir,
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toBe('review the code')
    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.content).toBe('LGTM outcome text')
    expect(messages[1]?.status).toBe('complete')
  })

  it('tier3 error shape: error text without result', async () => {
    const base = zcodeRecord({ sessionRef: {}, poolKey: POOL_KEY })
    const record: EngineAwareRecord = { ...base, result: undefined, error: 'engine_run_failed: boom' }
    const messages = await readEngineSubagentHistory(record, dataDir)
    expect(messages[1]?.content).toBe('engine_run_failed: boom')
    expect(messages[1]?.status).toBe('error')
  })

  it('rejects journal path outside engines root without reading it (前缀白名单)', async () => {
    // 越界 journal 指向真实存在的文件且内容是可重放的②级事件——若被读取会产出
    // "from journal"内容；断言输出是③级 outcome 文本即证明未读该文件
    const outsideDir = mkdtempSync(join(tmpdir(), 'sa-outside-'))
    const outsideJournal = join(outsideDir, 'journal-stolen.jsonl')
    writeFileSync(outsideJournal, `${journalLine(0, { type: 'text_delta', delta: 'STOLEN CONTENT' })}\n`, 'utf-8')

    try {
      const messages = await readEngineSubagentHistory(
        zcodeRecord({ sessionRef: { dbPath: DB_RELATIVE, sessionId: SESSION_ID }, journalPath: outsideJournal, poolKey: POOL_KEY }),
        dataDir,
      )
      expect(messages[1]?.content).toBe('LGTM outcome text')
      expect(JSON.stringify(messages)).not.toContain('STOLEN')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('rejects db path escaping the pool dir (①级白名单)', async () => {
    // 绝对路径形态落在池外（/tmp 下）——resolve 后不在 poolDir 内必须被拒绝
    const outsideDb = join(dataDir, 'outside.sqlite')
    const messages = await readEngineSubagentHistory(
      zcodeRecord({
        sessionRef: { dbPath: outsideDb, sessionId: SESSION_ID },
        poolKey: POOL_KEY,
      }),
      dataDir,
    )
    // ①级拒绝 + 无 journal → ③级
    expect(messages[1]?.content).toBe('LGTM outcome text')
  })

  it('degrades to outcome-only when engineHandle is missing (空值防御)', async () => {
    const messages = await readEngineSubagentHistory(zcodeRecord(undefined), dataDir)
    expect(messages[1]?.content).toBe('LGTM outcome text')
  })

  it('degrades to outcome-only for unknown engines (未来引擎保底)', async () => {
    const messages = await readEngineSubagentHistory(zcodeRecord(undefined, 'claude-code'), dataDir)
    expect(messages[1]?.content).toBe('LGTM outcome text')
  })
})

describe('readEngineSubagentHistory（pi 契约）', () => {
  it('returns empty array for pi records — caller keeps existing JSONL chain (A1)', async () => {
    const record = zcodeRecord(undefined, 'pi')
    delete (record as { engineHandle?: unknown }).engineHandle
    await expect(readEngineSubagentHistory(record, dataDir)).resolves.toEqual([])
  })
})
