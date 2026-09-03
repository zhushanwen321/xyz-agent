/**
 * subagent-engine-history —— P5 分协议历史读取链（设计 D6 三级降级）。
 *
 * 职责：非 pi 引擎 record 的 GUI 历史详情读取，按 ①引擎原生共享 reader（extension/
 * runtime 双端复用同一份，zcode sqlite）→ ②宿主 event journal 重放（前缀白名单）→
 * ③outcome-only（record 字段投影）逐级降级，每级失败留 debug 日志不抛崩溃（设计
 * A8：详情页永不白屏报错）。
 *
 * 为什么独立于 subagent-extractor.ts：extractor 是 entry 扫描器（纯派生列表，666 行
 * 聚合点），历史读取链是另一个关注点（session 定位 + Message 投影）——混排会让
 * 「列表派生」与「详情读取」互相污染回归面。
 *
 * pi 的历史读取不经过本文件：session-service.getSubagentHistory 的 pi 分支保持现有
 * JSONL 直读链（getHistoryFromFilePath），A1 守护（pi 现有直读行为零变化）。
 *
 * record.engine / record.engineHandle 消费契约（并行任务写侧）：`engine?: string`
 * （缺省 = pi，存量 record 零迁移）；`engineHandle?: { sessionRef, journalPath?,
 * poolKey }`（journalPath 绝对路径；sessionRef.dbPath 相对池目录 / 绝对路径）。
 * 写侧落地前字段缺失 → 防御式降级（空值防御，不依赖其完成时序）。
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { toErrorMessage } from '../../utils/errors.js'
import { isStrictlyUnder } from '../../utils/path-utils.js'
import type { SubagentRecord, Message, ToolCall as SharedToolCall } from '@xyz-agent/shared'
// 双端复用的无状态 reader（设计 §3.3.1 例外条款：runtime 永不 import 引擎运行时件，
// 唯一例外 = 共享 reader 模块 + 中立制品）。此处只 import zcode reader + 零副作用
// 常量 + 路径布局 SSOT（禁自拼路径，与 extension 写侧同源推导）。
import {
  resolveEnginesRoot,
  resolvePoolDir,
} from '@zhushanwen/subagent-core/engine/paths'
import {
  readZcodeSessionView,
} from '@zhushanwen/subagent-core/engines/zcode/reader'
import { ZCODE_ENGINE_ID, ZCODE_HOST_DB_SUFFIX } from '@zhushanwen/subagent-core/engines/zcode/constants'

/** record 引擎路由段的缺省引擎：存量 record 无 engine 字段 → 按 pi 投影（零迁移）。 */
export const DEFAULT_SUBAGENT_ENGINE = 'pi'

/**
 * record 路由段：从 record 的 engine 字段选引擎。
 *
 * 消费契约（并行任务写侧）：`record.engine?: string`（'pi' | 'zcode' | ...），缺省 =
 * pi。字段由 engine 抽象任务在 shared SubagentRecord / extractor 投影写入——落地前
 * 本函数恒返回 pi（防御式，不依赖其完成时序）。
 */
export function extractRecordEngine(record: SubagentRecord): string {
  const engine = (record as { engine?: unknown }).engine
  return typeof engine === 'string' && engine.length > 0 ? engine : DEFAULT_SUBAGENT_ENGINE
}

/**
 * record 携带的引擎 handle（消费面形状 = EngineHandleData 的子集）。
 * 并行任务契约：record.engineHandle 自描述定位符（journalPath 绝对路径；sessionRef
 * 内 dbPath 相对池目录 / 绝对路径均可）。写侧落地前字段缺失 → undefined，②③级按缺
 * 数据降级（空值防御，不抛）。
 */
export interface SubagentEngineHandle {
  /** 引擎自定义定位符（zcode = { sessionId, dbPath }）。 */
  sessionRef: Record<string, string>
  /** journal 绝对路径（②级数据源；读前校验前缀白名单）。 */
  journalPath?: string
  /** 隔离池定位（路径布局 SSOT：resolvePoolDir 消费）。 */
  poolKey: string
}

function extractRecordEngineHandle(record: SubagentRecord): SubagentEngineHandle | undefined {
  const raw = (record as { engineHandle?: unknown }).engineHandle
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const h = raw as Record<string, unknown>
  if (typeof h.poolKey !== 'string' || h.poolKey.length === 0) return undefined
  if (typeof h.sessionRef !== 'object' || h.sessionRef === null || Array.isArray(h.sessionRef)) return undefined
  const sessionRef: Record<string, string> = {}
  for (const [k, v] of Object.entries(h.sessionRef as Record<string, unknown>)) {
    if (typeof v === 'string') sessionRef[k] = v
  }
  const journalPath = typeof h.journalPath === 'string' && h.journalPath.length > 0 ? h.journalPath : undefined
  return {
    sessionRef,
    ...(journalPath !== undefined ? { journalPath } : {}),
    poolKey: h.poolKey,
  }
}

/** 引擎 ToolCall 在 runtime 侧的最小消费面（SessionView.toolCalls 与 journal 重放共用）。 */
interface EngineToolCallView {
  toolName: string
  args?: unknown
  result?: { content?: unknown[]; details?: unknown }
  isError?: boolean
}

/** ①②级共用的中间 turn 形状（投影到 shared Message 前的聚合单元）。 */
interface HistoryTurnView {
  text: string
  thinking: string
  toolCalls: EngineToolCallView[]
  usage?: { input: number; output: number }
  /** ②级 reducer 的闭合标志（turn_end 后下个内容事件开新 turn）。①级投影恒 false。 */
  closed?: boolean
}

/** zcode reader 返回的 SessionView（type 推导取得，不直接 import extension 类型面）。 */
type ZcodeSessionView = Awaited<ReturnType<typeof readZcodeSessionView>>
type ZcodeReplayedTurn = ZcodeSessionView['turns'][number]

/**
 * 非 pi record 的历史详情读取（三级降级主入口，P5）。
 *
 * 降级顺序①→②→③逐级 try，每级失败留 debug/warn 日志（不抛崩溃——GUI 详情页永不
 * 白屏报错，设计 A8）。pi record 返回 []：pi 的①级 = 调用方现有 JSONL 直读链
 * （session-service.getSubagentHistory），不在本函数重复实现（A1 守护：pi 行为零变化）。
 *
 * @param dataDir xyz-agent 数据根（getDataDir() 产物；journal/dbPath 白名单与
 *                extension 写侧经同一份 paths.ts 布局 SSOT 推导，禁自拼）
 */
export async function readEngineSubagentHistory(record: SubagentRecord, dataDir: string): Promise<Message[]> {
  const engine = extractRecordEngine(record)
  if (engine === DEFAULT_SUBAGENT_ENGINE) return []
  const handle = extractRecordEngineHandle(record)
  if (handle === undefined) {
    console.debug(
      `[subagent-engine-history] engine '${engine}' record has no engineHandle, degrade to outcome-only ` +
        `(subagentId=${record.subagentId})`,
    )
    return outcomeOnlyMessages(record)
  }
  if (engine === ZCODE_ENGINE_ID) {
    const native = await readZcodeNativeTier(record, handle, dataDir)
    if (native !== undefined) return native
    const journaled = readJournalTier(record, handle, dataDir)
    if (journaled !== undefined) return journaled
    return outcomeOnlyMessages(record)
  }
  // 未来引擎（reader 未接入）：③级保底——record 字段就够，详情页至少有摘要卡
  console.debug(
    `[subagent-engine-history] engine '${engine}' has no native reader tier, degrade to outcome-only ` +
      `(subagentId=${record.subagentId})`,
  )
  return outcomeOnlyMessages(record)
}

/**
 * ①级：zcode sqlite 原生读取（extension/runtime 双端复用同一份 reader）。
 * 返回 undefined = 本级不可达/失败（调用方降②级）。
 */
async function readZcodeNativeTier(
  record: SubagentRecord,
  handle: SubagentEngineHandle,
  dataDir: string,
): Promise<Message[] | undefined> {
  const dbPathRaw = handle.sessionRef['dbPath']
  const sessionId = handle.sessionRef['sessionId']
  if (typeof dbPathRaw !== 'string' || typeof sessionId !== 'string') {
    console.debug(
      `[subagent-engine-history] zcode tier1 skipped: handle missing dbPath/sessionId (subagentId=${record.subagentId})`,
    )
    return undefined
  }
  let dbPath: string
  if (dbPathRaw.startsWith('/')) {
    // 共享宿主 HOME 形态（2026-09 起）：唯一合法绝对路径 = 宿主 zcode 会话 db
    // （record 来自 JSONL 文本不可信，精确匹配 core SSOT 后缀拼出的路径，防任意读）
    if (dbPathRaw !== resolve(homedir(), ...ZCODE_HOST_DB_SUFFIX)) {
      console.warn(`[subagent-engine-history] zcode absolute dbPath not host db, reject tier1: ${dbPathRaw}`)
      return undefined
    }
    dbPath = dbPathRaw
  } else {
    // 旧池时代 records（HOME 池化时期）：相对路径锚池目录重定位，白名单防逃逸
    const poolDir = resolvePoolDir(dataDir, ZCODE_ENGINE_ID, handle.poolKey)
    dbPath = resolve(poolDir, dbPathRaw)
    if (!isStrictlyUnder(poolDir, dbPath)) {
      console.warn(`[subagent-engine-history] zcode dbPath escapes pool dir, reject tier1: ${dbPath}`)
      return undefined
    }
  }
  try {
    const view = await readZcodeSessionView(dbPath, sessionId)
    return sessionViewToMessages(view, record)
  } catch (e) {
    console.debug(
      `[subagent-engine-history] zcode tier1 read failed, degrade to journal tier ` +
        `(subagentId=${record.subagentId}): ${toErrorMessage(e)}`,
    )
    return undefined
  }
}

/**
 * ②级：宿主 event journal 重放。返回 undefined = 本级不可达/重放无内容（降③级）。
 *
 * 前缀白名单：journalPath 必须严格落在 resolveEnginesRoot(dataDir) 之下（与 extension
 * 写侧同一份 paths.ts 布局 SSOT 推导）——越界路径（../ 逃逸、engines 前缀外）拒绝并
 * 降③级，不抛崩溃、不读文件。
 */
function readJournalTier(record: SubagentRecord, handle: SubagentEngineHandle, dataDir: string): Message[] | undefined {
  const journalPath = handle.journalPath
  if (journalPath === undefined) {
    console.debug(
      `[subagent-engine-history] tier2 skipped: no journalPath in handle (subagentId=${record.subagentId})`,
    )
    return undefined
  }
  if (!isStrictlyUnder(resolveEnginesRoot(dataDir), journalPath)) {
    console.warn(`[subagent-engine-history] journalPath escapes engines root, reject tier2: ${journalPath}`)
    return undefined
  }
  const events = replayEngineJournal(journalPath)
  const messages = journalEventsToMessages(events, record)
  if (messages === undefined) {
    console.debug(
      `[subagent-engine-history] tier2 journal replay produced no content, degrade to outcome-only ` +
        `(subagentId=${record.subagentId}, path=${journalPath})`,
    )
  }
  return messages
}

/**
 * journal 最小重放（读侧）。行格式 v1 锚定 extension
 * common/event-journal.ts 的 JournalLine（写侧 SSOT + 设计 §3.3.6）。
 *
 * 为什么不直接 import replayJournal：该模块模块级 getLogger 会连带
 * pi-extension-logger → pi-coding-agent 巨包进 runtime bundle（依赖方向纪律的事故
 * 形态）。读侧逻辑只有「parse + 按 seq 排序」，格式漂移由写侧与 conformance 套件
 * （C5 重放等价性）守护。
 */
function replayEngineJournal(path: string): Array<Record<string, unknown>> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  const lines: Array<{ seq: number; event: Record<string, unknown> }> = []
  for (const row of raw.split('\n')) {
    const trimmed = row.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // 追加写产物末行可能截断——损坏行跳过优于整体失败（设计 C5「三级都不 throw」）
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const rec = parsed as Record<string, unknown>
    if (rec.v !== 1 || typeof rec.seq !== 'number') continue
    const event = rec.event
    if (typeof event !== 'object' || event === null) continue
    if (typeof (event as Record<string, unknown>).type !== 'string') continue
    lines.push({ seq: rec.seq, event: event as Record<string, unknown> })
  }
  // seq 是 host 侧单调递增序号——重放顺序权威（不依赖文件行序，§3.3.6）
  lines.sort((a, b) => a.seq - b.seq)
  return lines.map((l) => l.event)
}

/** ②级重放 reducer 的聚合状态（turn 列表 + tool 配对栈 + assistant 内容标志）。 */
interface JournalReducerState {
  turns: HistoryTurnView[]
  pendingTools: EngineToolCallView[]
  sawAssistantContent: boolean
}

/** 当前 turn = 最后一个未闭合项（数组即状态，避免闭包内 let 赋值的 CFA 陷阱）。 */
function ensureReducerTurn(state: JournalReducerState): HistoryTurnView {
  const last = state.turns[state.turns.length - 1]
  if (last !== undefined && last.closed !== true) return last
  const created: HistoryTurnView = { text: '', thinking: '', toolCalls: [], closed: false }
  state.turns.push(created)
  return created
}

function applyTextDelta(ev: Record<string, unknown>, state: JournalReducerState): void {
  if (typeof ev.delta === 'string' && ev.delta.length > 0) {
    ensureReducerTurn(state).text += ev.delta
    state.sawAssistantContent = true
  }
}

function applyThinkingDelta(ev: Record<string, unknown>, state: JournalReducerState): void {
  if (typeof ev.delta === 'string' && ev.delta.length > 0) {
    ensureReducerTurn(state).thinking += ev.delta
    state.sawAssistantContent = true
  }
}

function applyToolStart(ev: Record<string, unknown>, state: JournalReducerState): void {
  if (typeof ev.toolName === 'string') {
    const turn = ensureReducerTurn(state)
    const view: EngineToolCallView = { toolName: ev.toolName, ...(ev.args !== undefined ? { args: ev.args } : {}) }
    turn.toolCalls.push(view)
    state.pendingTools.push(view)
    state.sawAssistantContent = true
  }
}

function applyToolEnd(ev: Record<string, unknown>, state: JournalReducerState): void {
  if (typeof ev.toolName === 'string') {
    // 同名栈式配对（journal 无 toolCallId，与 AgentEvent 形状一致）
    for (let i = state.pendingTools.length - 1; i >= 0; i--) {
      const p = state.pendingTools[i]
      if (p !== undefined && p.toolName === ev.toolName) {
        p.result = typeof ev.result === 'object' && ev.result !== null
          ? (ev.result as { content?: unknown[]; details?: unknown })
          : undefined
        p.isError = ev.isError === true
        state.pendingTools.splice(i, 1)
        break
      }
    }
  }
}

function applyMessageEnd(ev: Record<string, unknown>, state: JournalReducerState): void {
  // usage 挂当前 turn（GUI 的 Message 粒度）；无未闭合 turn 时忽略（异常序列防御）
  const turn = state.turns[state.turns.length - 1]
  if (turn !== undefined && turn.closed !== true && typeof ev.usage === 'object' && ev.usage !== null) {
    const u = ev.usage as Record<string, unknown>
    const input = typeof u.input === 'number' ? u.input : 0
    const output = typeof u.output === 'number' ? u.output : 0
    if (input > 0 || output > 0) {
      turn.usage = { input, output }
      state.sawAssistantContent = true
    }
  }
}

/** turn 边界：闭合当前 turn（下个内容事件开新 turn）。 */
function closeReducerTurn(state: JournalReducerState): void {
  const turn = state.turns[state.turns.length - 1]
  if (turn !== undefined) turn.closed = true
}

function applyErrorEvent(ev: Record<string, unknown>, state: JournalReducerState): void {
  const turn = ensureReducerTurn(state)
  if (typeof ev.message === 'string' && turn.text === '') {
    turn.text = ev.message
    state.sawAssistantContent = true
  }
}

/** 单事件分发：按 type 路由到 per-case handler（reducer 的 switch 段）。 */
function applyJournalEvent(ev: Record<string, unknown>, state: JournalReducerState): void {
  switch (ev.type) {
    case 'text_delta':
      applyTextDelta(ev, state)
      break
    case 'thinking_delta':
      applyThinkingDelta(ev, state)
      break
    case 'tool_start':
      applyToolStart(ev, state)
      break
    case 'tool_end':
      applyToolEnd(ev, state)
      break
    case 'message_end':
      applyMessageEnd(ev, state)
      break
    case 'turn_end':
      closeReducerTurn(state)
      break
    case 'error':
      applyErrorEvent(ev, state)
      break
    default:
      break
  }
}

/** journal 事件 → Message[]（重放 reducer）。无任何 assistant 内容 → undefined（降③级）。 */
function journalEventsToMessages(events: Array<Record<string, unknown>>, record: SubagentRecord): Message[] | undefined {
  const state: JournalReducerState = { turns: [], pendingTools: [], sawAssistantContent: false }
  for (const ev of events) {
    applyJournalEvent(ev, state)
  }
  if (!state.sawAssistantContent) return undefined
  return turnsToMessages(state.turns, record)
}

/** ①级 SessionView → Message[]（user task + 每 turn 一条 assistant）。 */
function sessionViewToMessages(view: ZcodeSessionView, record: SubagentRecord): Message[] {
  const turns: HistoryTurnView[] = view.turns.map((t: ZcodeReplayedTurn) => ({
    text: t.text,
    thinking: t.thinking,
    toolCalls: t.toolCalls.map((tc) => ({
      toolName: tc.toolName,
      ...(tc.args !== undefined ? { args: tc.args } : {}),
      ...(tc.result !== undefined ? { result: tc.result } : {}),
      ...(tc.isError !== undefined ? { isError: tc.isError } : {}),
    })),
  }))
  // SessionView.usage 是各 turn 聚合（无 per-turn 拆分）——挂最后一个 turn 供 GUI 展示
  if (view.usage !== undefined && turns.length > 0) {
    const last = turns[turns.length - 1]
    if (last !== undefined) {
      last.usage = { input: view.usage.input, output: view.usage.output }
    }
  }
  return turnsToMessages(turns, record)
}

/** HistoryTurnView[] → Message[]（①②级共用投影；user task 前置一条）。 */
function turnsToMessages(turns: HistoryTurnView[], record: SubagentRecord): Message[] {
  const base = record.startedAt ?? Date.now()
  const messages: Message[] = []
  if (record.task.length > 0) {
    messages.push({
      id: randomUUID(),
      role: 'user',
      content: record.task,
      status: 'complete',
      timestamp: base,
    })
  }
  for (const [i, turn] of turns.entries()) {
    messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: turn.text,
      status: 'complete',
      ...(turn.thinking.length > 0
        ? { thinking: [{ id: randomUUID(), content: turn.thinking, collapsed: true }] }
        : {}),
      ...(turn.toolCalls.length > 0
        ? { toolCalls: turn.toolCalls.map((tc) => toSharedToolCall(tc, base + i + 1)) }
        : {}),
      ...(turn.usage !== undefined
        ? { usage: { inputTokens: turn.usage.input, outputTokens: turn.usage.output } }
        : {}),
      timestamp: base + i + 1,
    })
  }
  return messages
}

/** 引擎 ToolCall → shared ToolCall（GUI 消费形状；id/时间戳为展示占位）。 */
function toSharedToolCall(tc: EngineToolCallView, ts: number): SharedToolCall {
  const output = extractTextFromContent(tc.result?.content)
  const details = tc.result?.details
  return {
    id: randomUUID(),
    toolName: tc.toolName,
    input: tc.args ?? {},
    ...(output !== undefined ? { output } : {}),
    ...(typeof details === 'object' && details !== null && !Array.isArray(details)
      ? { details: details as Record<string, unknown> }
      : {}),
    status: tc.isError === true ? 'error' : 'completed',
    startTime: ts,
    endTime: ts,
  }
}

/** tool result content（unknown[]）→ 拼接文本（string 元素 + {type:'text',text} 块）。 */
function extractTextFromContent(content: unknown[] | undefined): string | undefined {
  if (content === undefined) return undefined
  let text = ''
  for (const block of content) {
    if (typeof block === 'string') {
      text += block
    } else if (typeof block === 'object' && block !== null) {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') text += b.text
    }
  }
  return text.length > 0 ? text : undefined
}

/**
 * ③级：outcome-only 投影（摘要卡数据源——record 现有字段就够，设计 D6「GUI 显示
 * 降级为摘要卡」）。①②级都不可达时兜底，永不返回空数组（详情页至少有 task/结果）。
 */
function outcomeOnlyMessages(record: SubagentRecord): Message[] {
  const base = record.startedAt ?? Date.now()
  const messages: Message[] = []
  if (record.task.length > 0) {
    messages.push({
      id: randomUUID(),
      role: 'user',
      content: record.task,
      status: 'complete',
      timestamp: base,
    })
  }
  const isErrorOutcome = record.result === undefined && record.error !== undefined
  messages.push({
    id: randomUUID(),
    role: 'assistant',
    // result 优先（正常轮终文本）；error 次之（失败终态）；双缺占位（运行中被杀等）
    content: record.result ?? record.error ?? '(no outcome recorded)',
    status: isErrorOutcome ? 'error' : 'complete',
    timestamp: record.endedAt ?? base,
    ...(isErrorOutcome && record.error !== undefined ? { error: record.error } : {}),
  })
  return messages
}
