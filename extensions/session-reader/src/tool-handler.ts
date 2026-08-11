/**
 * [M3 工具适配层] session_read 工具的纯逻辑 handler（design §3.4 接口规格）。
 *
 * 分层约定（同 scheduler/cw-tool）：本文件零 pi 依赖——agentDir 作参数注入，
 * 不调用 getAgentDir()，可完全单测；pi 注册与 getAgentDir() 调用在 index.ts。
 *
 * 按 action 分发到 7 条路径，串联 M1 core（parser/tree/turns/render）+ M2 discovery
 *（find/subagents）。content 给 LLM 读（人类可读摘要），details 供程序化消费/测试断言。
 *
 * 错误规格 F1-F6：handler 抛 Error（message 含 👉 恢复指引），由 index.ts 的 execute
 * 闭包 catch 转 isError:true 文本返回——handler 可抛（纯逻辑可测），execute 不抛（pi 契约）。
 * 例外：F2 多匹配与 F1 find 零匹配「不视为错误」，返回消歧/提示结果而非抛错。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findSessions, type MatchedSession } from './discovery/find.js'
import { buildFamilyFromFs } from './discovery/subagents.js'
import { parseSessionFile, type Entry } from './core/parser.js'
import { buildTreeView } from './core/tree.js'
import { segmentTurns } from './core/turns.js'
import {
  renderOutline,
  renderExpand,
  renderDetail,
  type OutlineOptions,
  type OutlineResult,
  type EntryBrief,
  type ToolResultSummaryEntry,
} from './core/render.js'
import type { Family } from './core/family.js'

// ---------------------------------------------------------------------------
// 公共类型（与 index.ts 的 TypeBox schema 对齐）
// ---------------------------------------------------------------------------

export type SessionReadAction =
  | 'find'
  | 'family'
  | 'outline'
  | 'expand'
  | 'detail'
  | 'search'
  | 'export'

export interface SessionReadParams {
  action: SessionReadAction
  session?: string
  query?: string
  turns?: string
  turn?: string
  pattern?: string
  scope?: 'all' | 'user' | 'assistant' | 'toolResult'
  format?: 'outline' | 'full' | 'family'
  includeToolResult?: boolean
  includeThinking?: boolean
  allBranches?: boolean
  granularity?: 'turn' | 'entry'
  cwd?: string
  limit?: number
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(3, '0')

/** 构造带 👉 恢复指引的 Error（handler 抛出，由 execute 闭包 catch）。 */
function err(message: string): Error {
  return new Error(message)
}

/** 剥 # 前缀（TUI `#e6c96` 引用 → 纯片段，design §3.3 D-3/D-4）。 */
function stripHash(s: string): string {
  return s.replace(/^#+/, '')
}

function formatDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

/** cwd 取末两段缩短显示（完整 cwd 在 details 里）。 */
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

function formatOmitted(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < 1024) return `[${bytes}B omitted]`
  return `[${Math.round(bytes / 1024)}KB omitted]`
}

/** F5 必填参数校验。 */
function requireStr(
  val: string | undefined,
  name: string,
  action: SessionReadAction,
): string {
  if (val === undefined || val === null || val.trim() === '') {
    throw err(`action:"${action}" 需要参数 "${name}"。👉 补上 "${name}" 重试。`)
  }
  return val.trim()
}

// ---------------------------------------------------------------------------
// turn / turns 索引解析
// ---------------------------------------------------------------------------

const TURN_RE = /^T?(\d+)$/i

function parseTurnIndex(raw: string): number {
  const m = raw.trim().match(TURN_RE)
  if (!m) {
    throw err(
      `turn "${raw}" 格式无效（应为 T013 或 013）。👉 用合法 turn 索引重试，或 outline 重看有效范围。`,
    )
  }
  return parseInt(m[1], 10)
}

function parseTurnsRange(raw: string): { start: number; end: number } {
  const parts = raw.split('-').map((s) => s.trim())
  if (parts.length === 1) {
    const i = parseTurnIndex(parts[0])
    return { start: i, end: i }
  }
  if (parts.length === 2) {
    const start = parseTurnIndex(parts[0])
    const end = parseTurnIndex(parts[1])
    if (end < start) {
      throw err(
        `turns 范围 "${raw}" 起始大于结束。👉 检查范围格式（如 T013-T015）重试。`,
      )
    }
    return { start, end }
  }
  throw err(`turns "${raw}" 格式无效（应为 T013 或 T013-T015）。👉 用合法范围重试。`)
}

function rangeLabel(r: { start: number; end: number }): string {
  return r.start === r.end ? `T${pad(r.start)}` : `T${pad(r.start)}-T${pad(r.end)}`
}

// ---------------------------------------------------------------------------
// resolveSessionId：片段 → 完整 id（design §3.4 resolveSessionId 辅助）
// ---------------------------------------------------------------------------

type ResolveResult =
  | { kind: 'ok'; sessionId: string; fileName: string }
  | { kind: 'multi'; query: string; candidates: MatchedSession[] }

/**
 * 把 session 参数（完整 id 或片段，可能带 # 前缀）解析到唯一完整 id。
 *
 * 走 findSessions（M2 已实现三路匹配：uuid 片段 / recent / 名称关键词）。
 * - 唯一匹配 → {kind:'ok'}（含 fileName，后续 parseSessionFile 直接用）
 * - 多匹配 → {kind:'multi'}（调用方据此返回 F2 消歧，不抛错）
 * - 零匹配 → 抛 F1（含最近 10 个 session 建议 + 👉，design §3.4 F1 模板）
 *
 * 仅用于 family/outline/expand/detail/search/export（find action 自行调 findSessions，
 * 零匹配时返回空 + 提示，不抛错）。
 */
async function resolveSessionId(
  rawSession: string | undefined,
  action: SessionReadAction,
  agentDir: string,
): Promise<ResolveResult> {
  const session = stripHash(requireStr(rawSession, 'session', action))
  const { matches } = await findSessions(session, agentDir, { limit: 10 })
  if (matches.length === 0) {
    const recent = await findSessions('recent', agentDir, { limit: 10 })
    throw err(formatNoMatch(session, recent.matches))
  }
  if (matches.length === 1) {
    return { kind: 'ok', sessionId: matches[0].sessionId, fileName: matches[0].fileName }
  }
  return { kind: 'multi', query: session, candidates: matches }
}

/** F1 无匹配 message（含最近 10 + 👉）。 */
function formatNoMatch(query: string, recent: MatchedSession[]): string {
  const lines: string[] = recent.length
    ? recent.map((m, i) => `  ${i + 1}. ${m.sessionId.slice(0, 8)}… ${m.firstMessagePreview ?? ''}`.trimEnd())
    : ['  （无历史 session）']
  return (
    `无匹配 session："${query}"。最近 ${recent.length} 个 session：\n${lines.join('\n')}\n` +
    `👉 用 session_read { action:"find", query:"recent" } 看全量，或换片段重试。`
  )
}

/** F2 多匹配消歧结果（不抛错，返回候选 + 👉）。 */
function disambiguate(query: string, candidates: MatchedSession[]): ToolResult {
  const lines = candidates.map(
    (m, i) =>
      `  ${i + 1}. ${m.sessionId} · ${formatDate(m.mtime)}${m.firstMessagePreview ? ' · ' + m.firstMessagePreview : ''}`,
  )
  const hint =
    candidates[0] !== undefined
      ? `（如 ${candidates[0].sessionId.slice(0, 12)}）`
      : ''
  const text =
    `${candidates.length} 个匹配 "${query}"：\n${lines.join('\n')}\n` +
    `👉 用更长的 uuid 片段${hint}，或 action:"find" 加 cwd 过滤。`
  return { content: [{ type: 'text', text }], details: { ambiguous: true, candidates } }
}

// ---------------------------------------------------------------------------
// 文件读取（F6 包装）
// ---------------------------------------------------------------------------

async function safeParse(fileName: string): Promise<Entry[]> {
  try {
    const { entries } = await parseSessionFile(fileName)
    return entries
  } catch (e) {
    throw err(
      `读取失败：${fileName}（${e instanceof Error ? e.message : String(e)}）。👉 检查文件或换 session。`,
    )
  }
}

// ---------------------------------------------------------------------------
// 文本渲染（content）
// ---------------------------------------------------------------------------

function formatFindContent(
  query: string,
  matches: MatchedSession[],
  truncated: boolean,
): string {
  const lines = matches.map((m, i) => {
    const parts = [`${i + 1}. ${m.sessionId.slice(0, 8)}…`, formatDate(m.mtime)]
    if (m.cwd) parts.push(shortCwd(m.cwd))
    if (m.firstMessagePreview) parts.push(m.firstMessagePreview)
    return parts.join(' · ')
  })
  const head = `${matches.length} session(s) matched "${query}"${
    truncated ? ` (truncated, showing first ${matches.length})` : ''
  }`
  return `${head}\n${lines.join('\n')}`
}

function formatOutlineText(r: OutlineResult): string {
  const lines = r.turns.map((b) => {
    const time = b.startTime ? b.startTime.match(/T(\d{2}:\d{2})/)?.[1] ?? '' : ''
    const parts = [`T${pad(b.index)}${time ? ' ' + time : ''}`]
    if (b.userBrief) parts.push(b.userBrief)
    if (b.toolSummary) parts.push(b.toolSummary)
    // v2 O1：补 assistant 结论行（→ ）让 outline 单独可决策
    if (b.assistantBrief) parts.push('→ ' + b.assistantBrief)
    const om = formatOmitted(b.omittedBytes)
    if (om) parts.push(om)
    if (b.branch) parts.push('[旁支]')
    return parts.join(' · ')
  })
  const tail = [
    '',
    `${r.stats.totalTurns} turns · ${r.stats.totalEntries} entries · ~${r.tokenEstimate} tokens`,
    r.truncated ? `[还有 ${r.truncated} 轮未显示，用 detail 或调大 budget]` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return `${lines.join('\n')}\n${tail}`
}

function formatExpandText(turn: string, entries: EntryBrief[]): string {
  const lines = entries.map(
    (e) =>
      `  [${e.index}] ${e.type}${e.role ? '/' + e.role : ''} ${e.brief}${
        e.omittedBytes > 0 ? ' ' + formatOmitted(e.omittedBytes) : ''
      }`,
  )
  return `${turn}\n${lines.join('\n')}`
}

/** 从 message.content 提取可读文本（text/thinking 块；tool_use 留 name 占位）。 */
function messageReadableText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>
          if (o.type === 'text' && typeof o.text === 'string') return o.text
          if (o.type === 'thinking' && typeof o.thinking === 'string') return `[thinking] ${o.thinking}`
          if (o.type === 'tool_use')
            return `[tool_use: ${typeof o.name === 'string' ? o.name : '?'}]`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * ToolResultSummaryEntry 判别（Entry.type 是宽 string，TS 无法靠 === 判别联合，须显式谓词收窄）。
 */
function isToolResultSummary(
  e: Entry | ToolResultSummaryEntry,
): e is ToolResultSummaryEntry {
  return e.type === 'toolResultSummary'
}

/**
 * 从 message.content 提取可读文本（text/thinking 块；tool_use 留 name 占位）。
 * v2 O3：接受 Entry | ToolResultSummaryEntry，toolResultSummary 返摘要文本（doExport full 用）。
 */
function entryReadableText(e: Entry | ToolResultSummaryEntry): string {
  if (isToolResultSummary(e)) {
    return `${e.summary} (共 ${e.totalLines} 行，前 3 行：${e.headLines})`
  }
  const msg = e.message
  if (msg !== undefined) {
    if (msg.role === 'toolResult') return `[toolResult] ${messageReadableText(msg.content)}`
    return messageReadableText(msg.content)
  }
  if (e.type === 'compaction')
    return `[compaction] ${typeof e.summary === 'string' ? e.summary : JSON.stringify(e.summary ?? '')}`
  if (e.type === 'custom') return `[custom:${e.customType ?? '?'}]`
  return `[${e.type}]`
}

function formatDetailText(
  range: { start: number; end: number },
  entries: Array<Entry | ToolResultSummaryEntry>,
): string {
  const head = `turns ${rangeLabel(range)} · ${entries.length} entries`
  const body = entries
    .map((e) => {
      if (isToolResultSummary(e)) {
        // v2 O3：摘要态渲染（summary + 头 3 行 + 看全文提示）
        return `---\ntoolResultSummary (${e.id.slice(0, 8)})\n${e.summary}\n     │ 共 ${e.totalLines} 行，前 3 行：${e.headLines}\n     │ （+ includeToolResult:true 看全文）`
      }
      const role = e.message ? `/${e.message.role}` : ''
      return `---\n${e.type}${role} (${e.id.slice(0, 8)})\n${entryReadableText(e)}`
    })
    .join('\n')
  return `${head}\n${body}`
}

function formatFamilyText(f: Family): string {
  const lines: string[] = []
  lines.push(`root: ${f.root.sessionId} (${formatDate(f.root.mtime)})`)
  if (f.parents.length)
    lines.push(`parents: ${f.parents.map((p) => p.sessionId.slice(0, 8)).join(', ')}`)
  if (f.forks.length)
    lines.push(`forks: ${f.forks.map((p) => p.sessionId.slice(0, 8)).join(', ')}`)
  if (f.subagents.length)
    lines.push(
      `subagents:\n${f.subagents
        .map(
          (s) =>
            `  ${s.sessionId.slice(0, 8)} root=${s.rootSessionId.slice(0, 8)} slug=${s.slug}${
              s.cleanedUp ? ' [已清理]' : ''
            }`,
        )
        .join('\n')}`,
    )
  if (f.workflows.length)
    lines.push(
      `workflows:\n${f.workflows
        .map((w) => `  ${w.runId} (${w.calls.length} calls)`)
        .join('\n')}`,
    )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// search 辅助
// ---------------------------------------------------------------------------

/** 编译检索 pattern：先当正则，非法则转义为字面子串（design §3.4 pattern 子串或正则）。 */
function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

/** 安全序列化：循环引用等异常时返回空串（catch 非空——记默认值）。 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return '' // 循环引用等致 stringify 失败，跳过该块
  }
}

/** search 的可检索文本：含 text/thinking/toolResult 全量（按 scope 过滤由调用方做）。 */
function searchableText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object') {
        const o = b as Record<string, unknown>
        if (typeof o.text === 'string') parts.push(o.text)
        else if (typeof o.thinking === 'string') parts.push(o.thinking)
        else {
          const serialized = safeStringify(o)
          if (serialized) parts.push(serialized)
        }
      }
    }
    return parts.join('\n')
  }
  return safeStringify(content)
}

function snippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 20)
  const end = Math.min(text.length, idx + len + 20)
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, end).replace(/\s+/g, ' ').trim() +
    (end < text.length ? '…' : '')
  )
}

// ===========================================================================
// 各 action 实现
// ===========================================================================

/** find：按片段/名称/recent 定位 session（design §3.4 find）。零匹配不抛，返回提示。 */
async function doFind(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const query = requireStr(params.query, 'query', 'find')
  const { matches, truncated } = await findSessions(query, agentDir, {
    cwd: params.cwd,
    limit: params.limit ?? 20,
  })
  if (matches.length === 0) {
    const recent = await findSessions('recent', agentDir, { limit: 10 })
    return {
      content: [{ type: 'text', text: formatNoMatch(query, recent.matches) }],
      details: { matches: [], truncated: false },
    }
  }
  return {
    content: [{ type: 'text', text: formatFindContent(query, matches, truncated) }],
    details: { matches, truncated },
  }
}

/** family：fork 父链/子代 + 隔代 subagent + workflow run（design §3.4 family）。 */
async function doFamily(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'family', agentDir)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  let family: Family
  try {
    family = await buildFamilyFromFs(resolved.sessionId, agentDir)
  } catch (e) {
    throw err(
      `读取家族失败：${resolved.sessionId}（${e instanceof Error ? e.message : String(e)}）。👉 检查 session 或用 find 重新定位。`,
    )
  }
  return { content: [{ type: 'text', text: formatFamilyText(family) }], details: family }
}

/** outline：turn 级全貌 TOC（design §3.4 outline，~500 token）。 */
async function doOutline(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'outline', agentDir)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const entries = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const opts: OutlineOptions = {
    budget: 2000,
    allBranches: params.allBranches,
    granularity: params.granularity,
  }
  const result = renderOutline(turns, tree, opts)
  return { content: [{ type: 'text', text: formatOutlineText(result) }], details: result }
}

/** expand：单 turn 的 entry 列表（design §3.4 expand）。turn 越界抛 F4。 */
async function doExpand(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'expand', agentDir)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const turnIdx = parseTurnIndex(requireStr(params.turn, 'turn', 'expand'))
  const entries = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const turn = turns.find((t) => t.index === turnIdx)
  if (turn === undefined) {
    const max = turns.length - 1
    throw err(
      `turn T${pad(turnIdx)} 越界，该 session 共 ${turns.length} 轮（T000-T${pad(Math.max(0, max))}）。👉 用 outline 重看有效范围。`,
    )
  }
  const result = renderExpand(turn)
  return {
    content: [{ type: 'text', text: formatExpandText(result.turn, result.entries) }],
    details: result,
  }
}

/** detail：turns 范围的完整文本（design §3.4 detail）。默认省略 toolResult/thinking。 */
async function doDetail(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'detail', agentDir)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const range = parseTurnsRange(requireStr(params.turns, 'turns', 'detail'))
  const entries = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const max = turns.length - 1
  if (turns.length === 0 || range.start > max || range.end > max) {
    throw err(
      `turns "${rangeLabel(range)}" 越界，该 session 共 ${turns.length} 轮（T000-T${pad(Math.max(0, max))}）。👉 用 outline 重看有效范围。`,
    )
  }
  const inRange = turns.filter((t) => t.index >= range.start && t.index <= range.end)
  const det = renderDetail(inRange, {
    includeToolResult: params.includeToolResult,
    includeThinking: params.includeThinking,
  })
  return {
    content: [{ type: 'text', text: formatDetailText(range, det) }],
    details: { turns: rangeLabel(range), entries: det },
  }
}

/** search：session 内全文检索（design §3.4 search，M3 新实现）。 */
async function doSearch(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'search', agentDir)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const pattern = requireStr(params.pattern, 'pattern', 'search')
  const scope = params.scope ?? 'all'
  const limit = params.limit ?? 20
  const entries = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const regex = compilePattern(pattern)
  const hits: Array<{
    turnIndex: number
    entryIndex: number
    role: string
    matchSnippet: string
  }> = []
  for (const t of turns) {
    for (let i = 0; i < t.entries.length; i++) {
      const msg = t.entries[i].message
      if (msg === undefined) continue
      if (scope !== 'all' && msg.role !== scope) continue
      const text = searchableText(msg.content)
      const m = regex.exec(text)
      if (m !== null) {
        hits.push({
          turnIndex: t.index,
          entryIndex: i,
          role: msg.role,
          matchSnippet: snippet(text, m.index, m[0].length),
        })
      }
    }
  }
  const truncated = hits.length > limit
  const sliced = truncated ? hits.slice(0, limit) : hits
  const lines = sliced.map(
    (h) => `  T${pad(h.turnIndex)} #${h.entryIndex} ${h.role}: ${h.matchSnippet}`,
  )
  const text = `${sliced.length} hit(s) for /${pattern}/${scope !== 'all' ? ' scope=' + scope : ''}${
    truncated ? ` (truncated, showing first ${sliced.length})` : ''
  }\n${lines.join('\n')}`
  return { content: [{ type: 'text', text }], details: { hits: sliced, truncated } }
}

/** export：物化摘要到 <agentDir>/tmp/session-view-<id>.md（design §3.4 export，D-8）。 */
async function doExport(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const format = params.format ?? 'outline'
  const resolved = await resolveSessionId(params.session, 'export', agentDir)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)

  let text: string
  let label: string
  if (format === 'family') {
    let family: Family
    try {
      family = await buildFamilyFromFs(resolved.sessionId, agentDir)
    } catch (e) {
      throw err(
        `读取家族失败：${resolved.sessionId}（${e instanceof Error ? e.message : String(e)}）。👉 检查 session 或用 find 重新定位。`,
      )
    }
    text = formatFamilyText(family)
    label = 'family'
  } else if (format === 'full') {
    const entries = await safeParse(resolved.fileName)
    const tree = buildTreeView(entries)
    const turns = segmentTurns(entries, new Set(tree.leafPath))
    const det = renderDetail(turns, {
      includeToolResult: params.includeToolResult,
      includeThinking: false,
    })
    text = det
      .map((e) => {
        if (isToolResultSummary(e)) {
          return `${'='.repeat(40)}\ntoolResultSummary (${e.id.slice(0, 8)})\n${entryReadableText(e)}`
        }
        return `${'='.repeat(40)}\n${e.type}${e.message ? '/' + e.message.role : ''} (${e.id.slice(0, 8)})\n${entryReadableText(e)}`
      })
      .join('\n')
    label = 'full'
  } else {
    const entries = await safeParse(resolved.fileName)
    const tree = buildTreeView(entries)
    const turns = segmentTurns(entries, new Set(tree.leafPath))
    const result = renderOutline(turns, tree, {
      budget: 2000,
      allBranches: params.allBranches,
      granularity: params.granularity,
    })
    text = formatOutlineText(result)
    label = 'outline'
  }

  const outDir = join(agentDir, 'tmp')
  const outPath = join(outDir, `session-view-${resolved.sessionId}.md`)
  await mkdir(outDir, { recursive: true })
  await writeFile(outPath, text, 'utf8')
  const sizeBytes = Buffer.byteLength(text, 'utf8')
  return {
    content: [
      {
        type: 'text',
        text: `已导出 ${label} 视图到 ${outPath}（${sizeBytes} bytes）。可用 read/grep 进一步检索。`,
      },
    ],
    details: { path: outPath, sizeBytes },
  }
}

// ===========================================================================
// 入口：按 action 分发
// ===========================================================================

/**
 * session_read 工具的纯逻辑 handler（agentDir 注入，零 pi 依赖，可单测）。
 *
 * 按 params.action 分发到 doFind/doFamily/doOutline/doExpand/doDetail/doSearch/doExport。
 * F1(resolve)/F4/F5/F6 抛 Error（含 👉）；F2 多匹配与 find 零匹配返回结果不抛。
 */
export async function handleSessionRead(
  params: SessionReadParams,
  agentDir: string,
): Promise<ToolResult> {
  switch (params.action) {
    case 'find':
      return doFind(params, agentDir)
    case 'family':
      return doFamily(params, agentDir)
    case 'outline':
      return doOutline(params, agentDir)
    case 'expand':
      return doExpand(params, agentDir)
    case 'detail':
      return doDetail(params, agentDir)
    case 'search':
      return doSearch(params, agentDir)
    case 'export':
      return doExport(params, agentDir)
    default: {
      // exhaustive guard：switch 覆盖全部 7 action，此处 params.action 收窄为 never；
      // 仅防御运行时非法 action（schema 正常校验下不可达）
      const exhaustive: never = params.action
      throw err(
        `未知 action "${JSON.stringify(exhaustive)}"。👉 合法 action: find/family/outline/expand/detail/search/export。`,
      )
    }
  }
}
