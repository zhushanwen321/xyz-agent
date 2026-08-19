/**
 * [M3 工具适配层] session_read 工具的纯逻辑 handler（design §3.4 接口规格）。
 *
 * 分层约定（同 scheduler/cw-tool）：本文件零 pi 依赖——agentDir 作参数注入，
 * 不调用 getAgentDir()，可完全单测；pi 注册与 getAgentDir() 调用在 index.ts。
 *
 * 按 action 分发到 8 条路径，串联 M1 core（parser/tree/turns/render）+ M2 discovery
 *（find/subagents）。content 给 LLM 读（人类可读摘要），details 供程序化消费/测试断言。
 *
 * 错误规格 F1-F6：handler 抛 Error（message 含 👉 恢复指引），index.ts 的 execute 闭包
 * 原样传播给 pi——pi-agent-core 只对 execute throw 置 isError:true（返回值里的 isError
 * 字段被丢弃，agent-loop.js:453-483）。handler 可抛（纯逻辑可测）。
 * 例外：F2 多匹配与 F1 find 零匹配「不视为错误」，返回消歧/提示结果而非抛错。
 */
import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { findSessions, type MatchedSession } from './discovery/find.js'
import { buildFamilyFromFs, listRecordManifests, type RecordManifest } from './discovery/subagents.js'
import { readRunSnapshot, resolveWorkflows } from './discovery/workflows.js'
import { parseSessionFile, type Entry, type ParseResult } from './core/parser.js'
import { parseRunSnapshot, renderWorkflowOverview, type WorkflowOverview } from './core/workflow.js'
import { buildTreeView } from './core/tree.js'
import { segmentTurns, type Turn } from './core/turns.js'
import { extractToolCalls, formatToolCallSummary, basename } from './core/toolcall.js'
import {
  renderOutline,
  renderExpand,
  renderDetail,
  type OutlineOptions,
  type OutlineResult,
  type EntryBrief,
  type ToolResultSummaryEntry,
} from './core/render.js'
import type { Family, SessionRef, WorkflowRef } from './core/family.js'
import {
  buildExecutionTree,
  formatExecutionTreeText,
  type ExecutionTree,
} from './core/execution-tree.js'

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
  | 'extract'
  | 'workflow'

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
  /** find/resolveSessionId: 按来源过滤。"main" = sessions/、"subagent" = subagents/。默认两者合并。 */
  source?: 'main' | 'subagent'
  /** workflow action: 可选，聚焦单个 runId（多 run 消歧）。不传 → 全部 run 概览。 */
  runId?: string
  limit?: number
  /** extract action: 素材类型（必填）。其他 action 忽略。 */
  what?: 'user-messages' | 'commands' | 'files' | 'commits' | 'tool-results'
  /** extract action: 过滤 commands/tool-results 的工具名（可选）。 */
  tool?: string
  /** family action: 返回嵌套执行树（任意深度 subagent↔workflow-call 相互嵌套）。默认 false（flat family）。 */
  recursive?: boolean
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

/** readSessionHeaderId 读首行的 buffer 上限。session header（id/cwd/parentSession）实测 < 300 字节，4KB 足够。 */
const HEADER_READ_BYTES = 4096

/**
 * 同步读 session 文件首行 header，返回 type==='session' 的 id。
 *
 * 任何异常（文件不存在/空文件/解析失败/type 不符）返回 undefined。与 find.ts readFirstLine/
 * parseHeader 同构（定长 buffer 读首行 + JSON.parse + type 校验），但用同步 fs API
 *（resolveSessionId 内仅调用 1 次，同步开销可接受），且不导出——避免与 w1 的 find.ts
 * 文件交叉（CQ2 决策）。
 */
function readSessionHeaderId(filePath: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(HEADER_READ_BYTES)
    const bytesRead = readSync(fd, buf, 0, HEADER_READ_BYTES, 0)
    if (bytesRead === 0) return undefined
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const nl = text.indexOf('\n')
    const line = nl === -1 ? text : text.slice(0, nl)
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return undefined
    }
    if (typeof raw !== 'object' || raw === null) return undefined
    const o = raw as Record<string, unknown>
    if (o.type !== 'session' || typeof o.id !== 'string') return undefined
    return o.id
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // closeSync 失败：fd 可能已无效，header 数据已读取，关闭失败不影响结果（best-effort）
        void fd
      }
    }
  }
}

/** ~ 前缀（home 目录简写），与 expandHome 配套避免 magic number。 */
const HOME_TILDE_PREFIX = '~/'

/** 展开 ~ 前缀到 homedir（'~' → homedir；'~/x' → homedir/x；其余原样）。 */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith(HOME_TILDE_PREFIX))
    return join(homedir(), p.slice(HOME_TILDE_PREFIX.length))
  return p
}

/**
 * 把 session 参数解析到唯一完整 id（design §6.1 M0 + U2/U3）。
 *
 * 三形态：
 * - ① 绝对路径 / ~ 前缀 → 展开后读首行 header，sessionId=header 真实 id（文件名仅定位）
 * - ② sa-id 前缀 → listRecordManifests 精确反查，sessionId=sessionFile header id
 *   （禁止降级 record.id——sa- 形态不可当 sessionId，CQ3 决策）
 * - ③ 其余 → findSessions 透传 source 沿用 F1/F2
 *
 * 错误契约（U3）：① 文件不存在/非 .jsonl/header 读不出 → F6 风格；
 * ② sessionFile GC → ES1（manifest 元数据 + 👉）；sa-id 0/>1 命中 → ES2（👉 family）。
 *
 * 仅用于 family/outline/expand/detail/search/export/extract（find action 自行调 findSessions，
 * 零匹配时返回空 + 提示，不抛错）。
 */
async function resolveSessionId(
  rawSession: string | undefined,
  action: SessionReadAction,
  agentDir: string,
  source?: 'main' | 'subagent',
): Promise<ResolveResult> {
  const session = stripHash(requireStr(rawSession, 'session', action))

  // ① 绝对路径或 ~ 前缀（Windows 盘符由 isAbsolute 处理）
  if (isAbsolute(session) || session === '~' || session.startsWith('~/')) {
    const expanded = expandHome(session)
    if (!expanded.endsWith('.jsonl')) {
      throw err(
        `读取失败：${session}（非 .jsonl session 文件）。👉 检查文件或换 session。`,
      )
    }
    if (!existsSync(expanded)) {
      throw err(`读取失败：${session}（文件不存在）。👉 检查文件或换 session。`)
    }
    const headerId = readSessionHeaderId(expanded)
    if (headerId === undefined) {
      throw err(
        `读取失败：${session}（首行非合法 session header）。👉 检查文件或换 session。`,
      )
    }
    return { kind: 'ok', sessionId: headerId, fileName: expanded }
  }

  // ② sa-id 前缀 → record manifest 精确反查
  if (session.startsWith('sa-')) {
    const manifests = await listRecordManifests(agentDir)
    const hits = manifests.filter((m) => m.id === session)
    if (hits.length === 0) {
      throw err(formatSaIdNotFound(session))
    }
    if (hits.length > 1) {
      throw err(formatSaIdAmbiguous(session, hits))
    }
    const record = hits[0]
    if (!existsSync(record.sessionFile)) {
      throw err(formatSessionGc(record))
    }
    const headerId = readSessionHeaderId(record.sessionFile)
    if (headerId === undefined) {
      // header 读不出不降级 record.id（sa- 形态不可当 sessionId，CQ3）
      throw err(
        `读取失败：${record.sessionFile}（首行非合法 session header）。👉 检查文件或换 session。`,
      )
    }
    return { kind: 'ok', sessionId: headerId, fileName: record.sessionFile }
  }

  // ③ 其余：findSessions 透传 source 沿用 F1/F2
  const opts = { limit: 10, ...(source ? { source } : {}) }
  const { matches } = await findSessions(session, agentDir, opts)
  if (matches.length === 0) {
    const recent = await findSessions('recent', agentDir, opts)
    throw err(formatNoMatch(session, recent.matches))
  }
  if (matches.length === 1) {
    return { kind: 'ok', sessionId: matches[0].sessionId, fileName: matches[0].fileName }
  }
  return { kind: 'multi', query: session, candidates: matches }
}

/** ES1（SESSION_FILE_GC）：sa-id 恰 1 命中但 sessionFile 不存在（GC/未写入）。含 manifest 元数据 + 👉。 */
function formatSessionGc(record: RecordManifest): string {
  return (
    `subagent "${record.id}" 的 session 文件不存在（可能已被 GC 或未写入）：\n` +
    `  rootSessionId: ${record.rootSessionId}\n` +
    `  agentName: ${record.agentName ?? '(未记录)'}\n` +
    `  sessionFile: ${record.sessionFile}\n` +
    `👉 改用 session_read { action:"family" } 查该 subagent 的后代，或换一个 completed subagent 重试。`
  )
}

/** ES2（SA_ID_NO_MATCH）：sa-id 无精确匹配（可能仍在运行 / 片段输入）。 */
function formatSaIdNotFound(saId: string): string {
  return (
    `subagent "${saId}" 无匹配 record（可能仍在运行——终态 record 在 completed/failed 后才写）。` +
    `\n👉 用 session_read { action:"family" } 查活跃/已完成的 subagent；` +
    `若是片段输入，请用完整 sa- id 或 action:"find" 重试。`
  )
}

/** ES2（SA_ID_AMBIGUOUS）：sa-id 多 manifest 命中（数据异常，record.id 应唯一）。 */
function formatSaIdAmbiguous(saId: string, records: RecordManifest[]): string {
  return (
    `subagent "${saId}" 匹配 ${records.length} 个 record（数据异常，record.id 应唯一）：\n` +
    records
      .map((r) => `  ${r.id} (root=${r.rootSessionId} file=${r.sessionFile})`)
      .join('\n') +
    `\n👉 用 session_read { action:"family" } 或完整 session uuid 重试。`
  )
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

async function safeParse(fileName: string): Promise<ParseResult> {
  try {
    return await parseSessionFile(fileName)
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

/** 从 message.content 提取可读文本（text/thinking 块；toolCall 留 name 占位）。 */
function messageReadableText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>
          if (o.type === 'text' && typeof o.text === 'string') return o.text
          if (o.type === 'thinking' && typeof o.thinking === 'string') return `[thinking] ${o.thinking}`
          if (o.type === 'toolCall')
            return `[toolCall: ${typeof o.name === 'string' ? o.name : '?'}]`
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
 * 从 message.content 提取可读文本（text/thinking 块；toolCall 留 name 占位）。
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

/**
 * 灾难性正则形态探测（MF-5）：组内含量词/`|` 且组本身又被量词修饰的 pattern
 *（`(a+)+`、`(a*)*`、`(a|aa)+`、`(a{1,3})*` 等）对长文本指数级回溯，可挂死整个 turn（5.4MB session
 * 全文逐 entry 匹配）。内层字符类含 `{` 以捕获 `{m,n}` 范围量词（MF-1）；`(a{1,3})` 单独使用
 *（组后无尾随量词）不命中，仍按正则执行。命中则降级为字面子串匹配（与非法正则同一兜底路径）。
 * 保守拒绝（把合法但形似的 pattern 降级为子串）比挂死可接受。
 */
function isCatastrophicPattern(pattern: string): boolean {
  return (
    /\((?:[^()\\]|\\.)*[+*?{](?:[^()\\]|\\.)*\)[+*?{]/.test(pattern) ||
    /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*?{]/.test(pattern)
  )
}

/** 编译检索 pattern：先当正则，非法/灾难性则转义为字面子串（design §3.4 pattern 子串或正则）。 */
function compilePattern(pattern: string): RegExp {
  if (isCatastrophicPattern(pattern)) {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
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
    ...(params.source ? { source: params.source } : {}),
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

/**
 * family：fork 父链/子代 + 隔代 subagent + workflow run（design §3.4 family）。
 *
 * recursive=false（默认）→ flat family（buildFamilyFromFs + formatFamilyText，m0/m1/m2 行为零回归）。
 * recursive=true → 嵌套执行树（buildExecutionTree + formatExecutionTreeText，任意深度
 * subagent↔workflow-call 相互嵌套，IF4）。错误契约同构：multi→disambiguate；构建抛错→catch 转 👉。
 */
async function doFamily(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'family', agentDir, params.source)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)

  // recursive=true：嵌套执行树（U7/U8）
  if (params.recursive) {
    let tree: ExecutionTree
    try {
      // MF-1：传 resolved.fileName 使 main root 填 sessionFile——main session 自身发起的
      // workflow run（workflow-state-link）进入执行树，与 flat family 行为一致。
      tree = await buildExecutionTree(resolved.sessionId, agentDir, resolved.fileName)
    } catch (e) {
      throw err(
        `构建执行树失败：${resolved.sessionId}（${e instanceof Error ? e.message : String(e)}）。👉 检查 session 或用 find 重新定位，或改用 recursive:false 看 flat family 兑底。`,
      )
    }
    return {
      content: [{ type: 'text', text: formatExecutionTreeText(tree) }],
      details: { tree },
    }
  }

  // recursive falsy（默认）：flat family（m0/m1/m2 现状零回归）
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
  const resolved = await resolveSessionId(params.session, 'outline', agentDir, params.source)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const { entries, totalBytes } = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const opts: OutlineOptions = {
    budget: 2000,
    allBranches: params.allBranches,
    granularity: params.granularity,
  }
  const result = renderOutline(turns, tree, opts)
  // 覆盖 stats.totalBytes：render 用 parsedBytes（leaf entry JSON 字节和）近似，
  // 此处用 ParseResult.totalBytes（原始文件字节数，design §3.4 stats.totalBytes 语义）
  result.stats.totalBytes = totalBytes
  return { content: [{ type: 'text', text: formatOutlineText(result) }], details: result }
}

/** expand：单 turn 的 entry 列表（design §3.4 expand）。turn 越界抛 F4。 */
async function doExpand(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'expand', agentDir, params.source)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const turnIdx = parseTurnIndex(requireStr(params.turn, 'turn', 'expand'))
  const { entries } = await safeParse(resolved.fileName)
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
  const resolved = await resolveSessionId(params.session, 'detail', agentDir, params.source)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const range = parseTurnsRange(requireStr(params.turns, 'turns', 'detail'))
  const { entries } = await safeParse(resolved.fileName)
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
async function doSearch(
  params: SessionReadParams,
  agentDir: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'search', agentDir, params.source)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const pattern = requireStr(params.pattern, 'pattern', 'search')
  const scope = params.scope ?? 'all'
  const limit = params.limit ?? 20
  const { entries } = await safeParse(resolved.fileName)
  const tree = buildTreeView(entries)
  const turns = segmentTurns(entries, new Set(tree.leafPath))
  const regex = compilePattern(pattern)
  // S-3：启发式降级时在 header 标注，避免 LLM 把 0 hit(s) 误读为「无匹配」（静默错数据）
  const degraded = isCatastrophicPattern(pattern)
  const hits: Array<{
    turnIndex: number
    entryIndex: number
    role: string
    matchSnippet: string
  }> = []
  for (const t of turns) {
    // MF-5：Esc/abort 后 pi 已丢弃本 turn 结果，尽早退出避免继续扫描长 session
    if (signal?.aborted) {
      throw err('搜索已中断（信号 aborted）。👉 重试或换更精确的 pattern。')
    }
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
  const text = `${sliced.length} hit(s) for /${pattern}/${degraded ? '（已降级为字面子串匹配）' : ''}${
    scope !== 'all' ? ' scope=' + scope : ''
  }${truncated ? ` (truncated, showing first ${sliced.length})` : ''}\n${lines.join('\n')}`
  return { content: [{ type: 'text', text }], details: { hits: sliced, truncated } }
}

/** export：物化摘要到 <agentDir>/tmp/session-view-<id>.md（design §3.4 export，D-8）。 */
async function doExport(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const format = params.format ?? 'outline'
  const resolved = await resolveSessionId(params.session, 'export', agentDir, params.source)
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
    const { entries } = await safeParse(resolved.fileName)
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
    const { entries } = await safeParse(resolved.fileName)
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
// extract action（v2 O4：跨 turn 按类型提取素材）
// ===========================================================================
//
// design §3.3 D3 的 5 个预设 + F7/F8/F9 错误规格。复用 O1 共享层（extractToolCalls /
// formatToolCallSummary / basename）与现有 resolveSessionId/safeParse/buildTreeView/
// segmentTurns/parseTurnsRange。纯提取，不调 LLM。

/** extract 的 5 个合法 what（design §3.3 D3）。 */
type ExtractWhat = 'user-messages' | 'commands' | 'files' | 'commits' | 'tool-results'

/** extract 结果预算（design §3.3 F9）：8000 字节 ≈ 2000 token。 */
const EXTRACT_BUDGET_BYTES = 8000

/** 含 path 参数的文件类工具（design §3.3 D3 files scope）。 */
const FILE_TOOLS = new Set(['read', 'edit', 'write', 'head'])

/** git 命令关键词（commits 预设判定 bash 结果是否来自 git 命令）。 */
const GIT_CMD_RE = /\bgit\s+(log|show|commit|push|merge|cherry-pick|revert|reset|rebase|diff)\b/
/** git short hash（commits 预设，保守限定 7-8 位避免 uuid 全量误报）。 */
const SHORT_HASH_RE = /\b[0-9a-f]{7,8}\b/g
/** commit 上下文消歧关键词（commits 次路径：hash 附近出现才纳入）。 */
const COMMIT_CTX_RE = /feat:|fix:|refactor:|chore:|docs:|\b(commit|commits|merged|pushed|merge)\b/i

/** what 类型守卫（直接比较，避开不安全断言；schema 已校验，此处防御 + 可单测绕过）。 */
function isExtractWhat(v: unknown): v is ExtractWhat {
  return (
    v === 'user-messages' ||
    v === 'commands' ||
    v === 'files' ||
    v === 'commits' ||
    v === 'tool-results'
  )
}

/**
 * 从 message.content 提取纯 text（string 直取；数组拼接 text 块）。
 *
 * 与 render.ts 内部 extractText 同语义，但那未导出；extract 仅需纯 text
 *（user-messages / tool-results 的正文），不要 thinking/toolCall 占位，本地实现。
 * content 是 unknown 做类型守卫。
 */
function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b !== null && typeof b === 'object') {
        const o = b as Record<string, unknown>
        if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/** 截断到 max 字符，超出加省略号（防爆；tool-results 正文用）。 */
function truncateText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** turns 数组紧凑标签（前 5 个 + +N，避免一行过长撑爆预算）。 */
function turnsLabel(turns: number[]): string {
  const head = turns.slice(0, 5).map((n) => `T${pad(n)}`)
  const suffix = turns.length > 5 ? `+${turns.length - 5}` : ''
  return head.join(',') + suffix
}

/**
 * 计算工具分布（按出现次数降序），用于 F8 提示 + details.toolDistribution。
 * 遍历 assistant entry 的 toolCall，复用 extractToolCalls。
 */
function computeToolDistribution(
  turns: Turn[],
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'assistant') continue
      for (const tc of extractToolCalls(e)) {
        counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1)
      }
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

/** F8：commands/tool-results 的 tool 过滤零匹配 → 返回工具分布 + 👉（不抛错，design §3.3 F8）。 */
function f8ToolNoMatch(what: ExtractWhat, tool: string, turns: Turn[]): ToolResult {
  const dist = computeToolDistribution(turns).slice(0, 10)
  const distStr = dist.map((d) => `${d.name}×${d.count}`).join(', ')
  const text = `what=${what} tool="${tool}" 无匹配。该 session 工具：${distStr}。👉 用存在的工具名重试。`
  return { content: [{ type: 'text', text }], details: { what, tool, toolDistribution: dist } }
}

/**
 * 通用预算渲染：逐项累加字节，超 EXTRACT_BUDGET_BYTES 截断（design §3.3 F9）。
 *
 * details.items 放实际展示的子集（截断后），count 放全集长度，测试可断言 shown/count/truncated。
 * emptyHint 仅 items 为空时用（files/commits 无匹配不报错，返空 + 提示）。
 *
 * 预算控制：按 item 累计字节达预算即截断。**首项超大也内部截断**（对单行 slice 到剩余字节预算，
 * 字节→字符 ×3 近似防 UTF8 多字节被切半），保证 body 不超预算——而非放行首项致 body 远超预算。
 * 导出供 tool-handler.test 单测 F9 截断逻辑（首项截断 + 文案含 turn 范围 + 实际 token）。
 *
 * getTurns：从 item 提取 turn 列表（files 是 turns 数组，其余单值包数组），供 F9 文案报 turn 范围。
 */
export function renderExtractItems<I>(
  what: ExtractWhat,
  items: I[],
  renderLine: (item: I) => string,
  getTurns: (item: I) => number[],
  emptyHint?: string,
): ToolResult {
  if (items.length === 0) {
    const text = emptyHint ?? `what=${what} 无匹配。`
    return {
      content: [{ type: 'text', text }],
      details: { what, count: 0, shown: 0, truncated: false, items: [] },
    }
  }
  const shown: I[] = []
  const shownLines: string[] = []
  let bytes = 0
  let cut = false
  for (const item of items) {
    const line = renderLine(item)
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1 // +\n
    if (bytes + lineBytes > EXTRACT_BUDGET_BYTES) {
      // 超预算：对当前 line 内部截断到剩余预算（首项超大也截断，但保留截断后的内容）
      const remainingBytes = EXTRACT_BUDGET_BYTES - bytes
      const charBudget = Math.floor(remainingBytes / 3) // 字节→字符 ×3 近似防 UTF8 切半
      if (charBudget > 0) {
        const sliced = line.slice(0, charBudget) + '…'
        shown.push(item)
        shownLines.push(sliced)
      }
      cut = true
      break
    }
    shown.push(item)
    shownLines.push(line)
    bytes += lineBytes
  }
  const body = shownLines.join('\n')
  if (!cut) {
    return {
      content: [{ type: 'text', text: body }],
      details: {
        what,
        count: items.length,
        shown: shown.length,
        truncated: false,
        items: shown,
      },
    }
  }
  // F9：超预算截断。tokens 反映 body 实际体积（非固定 2000）；文案报 shown/count + turn 范围 + 实际 token
  const shownTurns = shown.flatMap(getTurns)
  const turnRange =
    shownTurns.length > 0
      ? `（T${pad(Math.min(...shownTurns))}-T${pad(Math.max(...shownTurns))}）`
      : ''
  const actualTokens = Math.round(Buffer.byteLength(body, 'utf8') / 4)
  const text =
    body +
    `\n[what=${what} 已显示 ${shown.length}/${items.length} 项${turnRange}，约 ${actualTokens} token 达预算上限。👉 用较小 turns 范围（如 T000-T005）缩小，或换 what 重试。]`
  return {
    content: [{ type: 'text', text }],
    details: {
      what,
      count: items.length,
      shown: shown.length,
      truncated: true,
      items: shown,
    },
  }
}

/** 预设 1：user-messages——收集 role==='user' 的全文（按 turn 排列，design §3.3 D3）。 */
function extractUserMessages(turns: Turn[]): ToolResult {
  const items: Array<{ turn: number; text: string }> = []
  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'user') continue
      items.push({ turn: t.index, text: extractContentText(e.message.content) })
    }
  }
  return renderExtractItems(
    'user-messages',
    items,
    (it) => `T${pad(it.turn)}: ${it.text}`,
    (it) => [it.turn],
  )
}

/**
 * 预设 2：commands——assistant 的 toolCall，带 name + D1 摘要（design §3.3 D3）。
 * 可选 tool 过滤；过滤后零匹配 → F8（工具分布 + 👉，不抛错）。
 * index = entry 在 turn.entries 内的位置，与 expand 的 [N] 对齐便于定位。
 */
function extractCommands(turns: Turn[], tool: string | undefined): ToolResult {
  const items: Array<{ turn: number; index: number; name: string; summary: string }> = []
  for (const t of turns) {
    for (let ei = 0; ei < t.entries.length; ei++) {
      const e = t.entries[ei]
      if (e.message?.role !== 'assistant') continue
      for (const tc of extractToolCalls(e)) {
        if (tool !== undefined && tc.name !== tool) continue
        items.push({
          turn: t.index,
          index: ei,
          name: tc.name,
          summary: formatToolCallSummary(tc),
        })
      }
    }
  }
  if (tool !== undefined && items.length === 0) return f8ToolNoMatch('commands', tool, turns)
  return renderExtractItems(
    'commands',
    items,
    (it) => `T${pad(it.turn)} #${it.index} ${it.summary}`,
    (it) => [it.turn],
  )
}

/**
 * 预设 3：files——read/edit/write/head 的 path 去重（design §3.3 D3）。
 * 同 path 多次操作合并，op 聚合成 `read+edit` 形式，turns 记录出现过的轮次。
 * todo/subagent/cw 无 path 不纳入。无匹配不报错（返空 + 提示）。
 */
function extractFiles(turns: Turn[]): ToolResult {
  const map = new Map<string, { ops: Set<string>; turns: Set<number> }>()
  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'assistant') continue
      for (const tc of extractToolCalls(e)) {
        if (!FILE_TOOLS.has(tc.name)) continue
        const p = tc.arguments.path
        if (typeof p !== 'string') continue
        let rec = map.get(p)
        if (rec === undefined) {
          rec = { ops: new Set(), turns: new Set() }
          map.set(p, rec)
        }
        rec.ops.add(tc.name)
        rec.turns.add(t.index)
      }
    }
  }
  const items = Array.from(map.entries()).map(([path, rec]) => ({
    path,
    basename: basename(path),
    op: Array.from(rec.ops).sort().join('+'),
    turns: Array.from(rec.turns).sort((a, b) => a - b),
  }))
  return renderExtractItems(
    'files',
    items,
    (it) => `${it.op}: ${it.path} (${turnsLabel(it.turns)})`,
    (it) => it.turns,
    `what=files 无匹配（该 session 无 read/edit/write/head 文件操作）。`,
  )
}

/**
 * 预设 4：commits——git 命令 toolResult 的 hash（design §3.3 D3 + D6 误匹配处理）。
 *
 * 保守策略（宁可少召回不要乱报 uuid）：
 * ① 主路径（高置信）：只从 bash 且关联 command 含 git (log|show|commit|push|merge|...) 的
 *    toolResult 文本提取 7-8 位 hex；
 * ② 次路径（中置信）：扫所有 toolResult 文本，hash 前后各 30 字符内含
 *    feat:/fix:/commit/merge 等关键词的才纳入；
 * ③ 去重，git-cmd 置信度优先；不扫 user/assistant 自由文本（uuid/session-id 误报太多）。
 *
 * 已知局限：7-8 位 hex 与 uuid v7 片段形似，靠 git 命令上下文过滤；仍可能漏报
 *（git 操作未被 toolResult 捕获）或误报（git log 输出里的其他 hex）。每条标注来源 turn
 * + source + context，agent 可快速辨认。完全语义判断需 LLM，本工具零 LLM 依赖。
 */
function extractCommits(turns: Turn[]): ToolResult {
  // 建 toolCallId → bash command 映射（用于判定 toolResult 是否来自 git 命令）
  const bashCmds = new Map<string, string>()
  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'assistant') continue
      for (const tc of extractToolCalls(e)) {
        if (tc.name === 'bash') {
          const cmd = tc.arguments.command
          if (typeof cmd === 'string') bashCmds.set(tc.id, cmd)
        }
      }
    }
  }

  type CommitItem = {
    hash: string
    turn: number
    source: 'git-cmd' | 'commit-context'
    context: string
  }
  const high: CommitItem[] = []
  const low: CommitItem[] = []

  for (const t of turns) {
    for (const e of t.entries) {
      if (e.message?.role !== 'toolResult') continue
      const msg = e.message
      const text = extractContentText(msg.content)
      if (text === '') continue
      const cmd = msg.toolCallId !== undefined ? bashCmds.get(msg.toolCallId) : undefined
      const isGitBash = msg.toolName === 'bash' && cmd !== undefined && GIT_CMD_RE.test(cmd)
      for (const m of text.matchAll(SHORT_HASH_RE)) {
        const hash = m[0]
        const idx = m.index ?? 0
        const ctx = text
          .slice(Math.max(0, idx - 30), idx + hash.length + 30)
          .replace(/\s+/g, ' ')
          .trim()
        if (isGitBash) {
          high.push({ hash, turn: t.index, source: 'git-cmd', context: ctx })
        } else if (COMMIT_CTX_RE.test(ctx)) {
          low.push({ hash, turn: t.index, source: 'commit-context', context: ctx })
        }
      }
    }
  }

  // 去重：高置信优先，同 hash 保留首次
  const seen = new Set<string>()
  const items: CommitItem[] = []
  for (const c of high) {
    if (seen.has(c.hash)) continue
    seen.add(c.hash)
    items.push(c)
  }
  for (const c of low) {
    if (seen.has(c.hash)) continue
    seen.add(c.hash)
    items.push(c)
  }

  return renderExtractItems(
    'commits',
    items,
    (it) => `T${pad(it.turn)} ${it.hash} [${it.source}] ${it.context}`,
    (it) => [it.turn],
    `what=commits 无匹配（该 session 无 git commit hash，或未在 toolResult 中出现）。`,
  )
}

/**
 * 预设 5：tool-results——role==='toolResult' 文本（design §3.3 D3）。
 * text 截断到 500 字防爆；可选 tool 过滤（msg.toolName）；过滤零匹配 → F8。
 */
function extractToolResults(turns: Turn[], tool: string | undefined): ToolResult {
  const items: Array<{ turn: number; index: number; toolName: string; text: string }> = []
  for (const t of turns) {
    for (let ei = 0; ei < t.entries.length; ei++) {
      const e = t.entries[ei]
      if (e.message?.role !== 'toolResult') continue
      const tn = e.message.toolName ?? '?'
      if (tool !== undefined && tn !== tool) continue
      const text = truncateText(extractContentText(e.message.content), 500)
      items.push({ turn: t.index, index: ei, toolName: tn, text })
    }
  }
  if (tool !== undefined && items.length === 0)
    return f8ToolNoMatch('tool-results', tool, turns)
  return renderExtractItems(
    'tool-results',
    items,
    (it) => `T${pad(it.turn)} #${it.index} ${it.toolName}: ${it.text}`,
    (it) => [it.turn],
  )
}

/**
 * extract：跨 turn 按类型提取素材（design §3.3 D3 五预设 + F7/F8/F9）。
 *
 * 流程：resolveSessionId（multi 走 disambiguate）→ safeParse → buildTreeView +
 * segmentTurns → 可选 turns 范围限定（复用 parseTurnsRange）→ F7 校验 what → 分发 5 预设。
 */
async function doExtract(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'extract', agentDir, params.source)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)
  const { entries } = await safeParse(resolved.fileName)
  // extract 遍历全量 entry（含旁支/压缩历史），与 outline/expand/detail 的 leaf 视图不同：
  // 素材提取要全量（design §2.3 实测全量 519 toolCall / 26 user / 515 toolResult），
  // 用 leafPath 过滤会漏掉旁支素材。turn 标注是全量分段 index（含 compaction 周期 + 旁支
  // turn），与 outline 的 32 leaf turn index 不一定逐一对齐，但素材内容完整。
  const allTurns = segmentTurns(entries, new Set(entries.map((e) => e.id)))

  // 可选 turns 范围限定（复用 parseTurnsRange；未传则全 session）
  let turns = allTurns
  if (params.turns !== undefined) {
    const range = parseTurnsRange(params.turns)
    const max = allTurns.length - 1
    if (allTurns.length === 0 || range.start > max || range.end > max) {
      throw err(
        `turns "${rangeLabel(range)}" 越界，extract 的 turn 范围与 outline 不同（extract 含 compaction 周期/旁支，turn 数更多）。该 session extract 共 ${allTurns.length} 轮（T000-T${pad(Math.max(0, max))}）。👉 用较小 turns 范围（如 T000-T005）试探，或先不带 turns extract 看全量 turn 标注。`,
      )
    }
    turns = allTurns.filter((t) => t.index >= range.start && t.index <= range.end)
  }

  // F7：what 校验（schema 已校验，此处防御 + 可单测绕过 schema）
  const what = params.what
  if (!isExtractWhat(what)) {
    const given = what === undefined ? '(missing)' : String(what)
    throw err(
      `what "${given}" 无效，应为 user-messages/commands/files/commits/tool-results。👉 用合法 what 重试。`,
    )
  }

  switch (what) {
    case 'user-messages':
      return extractUserMessages(turns)
    case 'commands':
      return extractCommands(turns, params.tool)
    case 'files':
      return extractFiles(turns)
    case 'commits':
      return extractCommits(turns)
    case 'tool-results':
      return extractToolResults(turns, params.tool)
    default: {
      // exhaustive guard：5 预设全覆盖，default 不可达；防御未来新增 what 未加 case
      const exhaustive: never = what
      throw err(`unreachable extract what: ${JSON.stringify(exhaustive)}`)
    }
  }
}

// ===========================================================================
// workflow action（w6：消费 w5 的 readRunSnapshot/parseRunSnapshot/renderWorkflowOverview）
// ===========================================================================

/** doWorkflow 的 details 结构（ES-wf-no-runs/runid-not-found/snapshot-* 错误契约的具体类型）。 */
interface WorkflowDetails {
  runs: WorkflowOverview[]
  runIds: string[]
  skippedRuns?: Array<{ runId: string; stateFile: string; reason: string }>
  requestedRunId?: string
  sessionId?: string
}

/** 单个被跳过的 run 记录（snapshot 不可读/不可解析）。 */
interface SkippedRun {
  runId: string
  stateFile: string
  reason: string
}

/**
 * workflow：workflow run 概览（design §3.4 workflow，m2 IF-doWorkflow）。
 *
 * 流程：① resolveSessionId（multi 走 disambiguate）→ ② 读目标 session 的 workflow-state-link
 * → ③ 无 run → ES-wf-no-runs（提示+👉family，不抛错）→ ④ runId 过滤，无匹配 →
 * ES-wf-runid-not-found（列候选+👉，不抛错）→ ⑤ 逐 run readRunSnapshot+parseRunSnapshot，
 * 不可读/不可解析 → skippedRuns（不中断其他 run，ES-wf-snapshot-read-fail/unparseable）
 * → ⑥ renderWorkflowOverview 拼接。
 *
 * ② 的读取（MF-2）：不用 buildFamilyFromFs（其 resolveFamily 只索引 main session，subagent
 * session 会抛「session not found in family index」）——resolveSessionId 已把 session 解析到
 * 真实文件（kind==='ok' 保证文件存在，三形态：绝对路径/sa-id 均 existsSync 校验，片段匹配
 * 来自实际 fs 扫描），直接用 resolved.fileName 构造单条目 sessionIdToPath 调 resolveWorkflows
 *（与 buildFamilyFromFs 步骤 6 的 workflow 腿同源）。pathToRef 仅含目标 session，call 引用
 * 走 sessionRefFromPath 文件名最小回退（sessionId+fileName，足够 LLM 跳 outline/detail 深读）。
 *
 * 错误契约（C2）：workflow 概览探索语义，三类错误均返回 ToolResult 不抛错。
 * step 的 call sessionId/sessionFile 是 LLM 跳 outline/detail 的入口（m0 resolveSessionId
 * 三形态复用：sessionId/绝对路径/sa-id 均可深读，TC-wf-step-sessionfile-link）。
 */
async function doWorkflow(params: SessionReadParams, agentDir: string): Promise<ToolResult> {
  const resolved = await resolveSessionId(params.session, 'workflow', agentDir, params.source)
  if (resolved.kind === 'multi') return disambiguate(resolved.query, resolved.candidates)

  let workflows: WorkflowRef[]
  try {
    // MF-2：直读 resolved.fileName（subagent session 亦可），绕过 buildFamilyFromFs 的
    // main-only byId 索引（对 subagent 抛「session not found in family index」）。
    // resolveWorkflows 自身容错（读失败返回 []），「session 真不存在」的 F 级契约已由
    // resolveSessionId 保证（kind==='ok' 前已 existsSync/扫描校验）。
    const sessionIdToPath = new Map<string, string>([[resolved.sessionId, resolved.fileName]])
    const pathToRef = new Map<string, SessionRef>()
    workflows = await resolveWorkflows(resolved.sessionId, sessionIdToPath, pathToRef)
  } catch (e) {
    throw err(
      `读取 workflow run 失败：${resolved.sessionId}（${e instanceof Error ? e.message : String(e)}）。👉 检查 session 或用 find 重新定位。`,
    )
  }
  const allRunIds = workflows.map((w) => w.runId)

  // ③ ES-wf-no-runs：session 未发起任何 workflow run（不抛错，返提示+👉family）
  if (workflows.length === 0) {
    const text =
      `session ${resolved.sessionId} 无 workflow run。\n` +
      `👉 用 session_read { action:'family' } 查该 session 的 subagent 后代，或确认 session 是否发起过 workflow。`
    const details: WorkflowDetails = { runs: [], runIds: [], sessionId: resolved.sessionId }
    return { content: [{ type: 'text', text }], details }
  }

  // ④ runId 过滤（可选，多 run 消歧）
  const requestedRunId =
    params.runId !== undefined && params.runId.trim() !== '' ? params.runId.trim() : undefined
  let selected: WorkflowRef[] = workflows
  if (requestedRunId !== undefined) {
    selected = workflows.filter((w) => w.runId === requestedRunId)
    if (selected.length === 0) {
      // ES-wf-runid-not-found：列出可用 runId + 👉（不抛错，与 F2 多匹配消歧同构）
      const lines = allRunIds.map((rid) => `  ${rid}`).join('\n')
      const text =
        `runId "${requestedRunId}" 无匹配。可用 runId：\n${lines}\n` +
        `👉 用上述完整 runId 重试，或不传 runId 看全部 run 概览。`
      const details: WorkflowDetails = { runs: [], runIds: allRunIds, requestedRunId }
      return { content: [{ type: 'text', text }], details }
    }
  }

  // ⑤⑥ 逐 run 读 snapshot → parse → render
  const runs: WorkflowOverview[] = []
  const runIds: string[] = []
  const skippedRuns: SkippedRun[] = []
  const contentParts: string[] = []

  for (const wf of selected) {
    const snap = await readRunSnapshot(wf.stateFile)
    if (snap === undefined) {
      // ES-wf-snapshot-read-fail：文件不存在/读失败/全行不可解析 → 跳过，不中断其他 run
      skippedRuns.push({ runId: wf.runId, stateFile: wf.stateFile, reason: 'snapshot-unreadable' })
      contentParts.push(`run ${wf.runId}: 快照不可读（stateFile=${wf.stateFile}）已跳过`)
      continue
    }
    const overview = parseRunSnapshot(snap, wf.runId, wf.stateFile)
    if (overview === null) {
      // ES-wf-snapshot-unparseable：对象既非 NEW 也非 OLD → 跳过
      skippedRuns.push({ runId: wf.runId, stateFile: wf.stateFile, reason: 'snapshot-unparseable' })
      contentParts.push(`run ${wf.runId}: 快照格式不可识别（stateFile=${wf.stateFile}）已跳过`)
      continue
    }
    runs.push(overview)
    runIds.push(wf.runId)
    contentParts.push(renderWorkflowOverview(overview))
  }

  const details: WorkflowDetails = { runs, runIds }
  if (requestedRunId !== undefined) details.requestedRunId = requestedRunId
  if (skippedRuns.length > 0) details.skippedRuns = skippedRuns

  // 全部 run 都跳过的兑底提示（ES-wf-snapshot-read-fail 末段）
  let text: string
  if (runs.length === 0) {
    text =
      contentParts.join('\n') +
      `\n👉 检查 stateFile 或用 session_read { action:'family' } 看 call session 直接深读。`
  } else {
    text = contentParts.join('\n\n')
  }

  return { content: [{ type: 'text', text }], details }
}

// ===========================================================================
// 入口：按 action 分发
// ===========================================================================

/**
 * session_read 工具的纯逻辑 handler（agentDir 注入，零 pi 依赖，可单测）。
 *
 * 按 params.action 分发到 doFind/doFamily/doOutline/doExpand/doDetail/doSearch/doExport。
 * F1(resolve)/F4/F5/F6 抛 Error（含 👉）；F2 多匹配与 find 零匹配返回结果不抛。
 *
 * @param signal 可选 AbortSignal（MF-5）：仅 search 消费（长扫描可中断）；其余 action 有界，不接。
 */
export async function handleSessionRead(
  params: SessionReadParams,
  agentDir: string,
  signal?: AbortSignal,
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
      return doSearch(params, agentDir, signal)
    case 'export':
      return doExport(params, agentDir)
    case 'extract':
      return doExtract(params, agentDir)
    case 'workflow':
      return doWorkflow(params, agentDir)
    default: {
      // exhaustive guard：switch 覆盖全部 9 action，此处 params.action 收窄为 never；
      // 仅防御运行时非法 action（schema 正常校验下不可达）
      const exhaustive: never = params.action
      throw err(
        `未知 action "${JSON.stringify(exhaustive)}"。👉 合法 action: find/family/outline/expand/detail/search/export/extract/workflow。`,
      )
    }
  }
}
