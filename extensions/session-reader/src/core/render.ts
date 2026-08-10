import type { Entry } from './parser.js'
import type { Turn } from './turns.js'
import type { TreeView } from './tree.js'

/**
 * L1 outline 的单行 turn 摘要（design §3.5 算法 1 的渲染单元，冻结接口）。
 *
 * 预算不足时按降级序清空 assistantBrief → toolSummary（保留 userBrief + omittedBytes 骨架），
 * 由 renderOutline 直接改写本对象的字段（消费方拿到的就是降级后的形态）。
 */
export interface TurnBrief {
  index: number
  startTime?: string
  /** user message text 截 60 字符（compaction turn 为 `[compaction] 摘要…`） */
  userBrief: string
  /** 聚合该 turn 所有 toolCall.name 计数 → `bash×2,read×2`；无则空串 */
  toolSummary: string
  /** assistant text 截 80 字符 */
  assistantBrief: string
  /** 该 turn 省略的 toolResult + thinking 字节数 */
  omittedBytes: number
  /** forkPointId（仅 allBranches 时设置：该 turn 含 forkPoint 节点） */
  branch?: string
}

export interface OutlineResult {
  turns: TurnBrief[]
  stats: { totalTurns: number; totalEntries: number; totalBytes: number; parsedBytes: number }
  /** chars / 4 近似（与 design P-outline 口径一致） */
  tokenEstimate: number
  /** 被总预算截断的 turn 数（从尾部丢弃） */
  truncated?: number
}

export interface OutlineOptions {
  /** 默认 2000（token） */
  budget?: number
  allBranches?: boolean
  /** 默认 turn；entry = 每 entry 一行不聚合（D-1 兜底，坏 session 调试） */
  granularity?: 'turn' | 'entry'
}

// ---------------------------------------------------------------------------
// content 类型守卫与提取（message.content 是 unknown，design §3.4）
// ---------------------------------------------------------------------------

interface ContentBlock {
  type?: unknown
  text?: unknown
  thinking?: unknown
}

function isStringContent(c: unknown): c is string {
  return typeof c === 'string'
}

function isBlockArray(c: unknown): c is ContentBlock[] {
  if (!Array.isArray(c)) return false
  return c.every((item) => typeof item === 'object' && item !== null)
}

function blockText(block: ContentBlock): string {
  return typeof block.text === 'string' ? block.text : ''
}

function blockThinking(block: ContentBlock): string {
  if (typeof block.thinking === 'string') return block.thinking
  // 兜底：个别实现把 thinking 文本放在 text 字段
  if (block.type === 'thinking' && typeof block.text === 'string') return block.text
  return ''
}

/** 拼接 text 块文本（排除 thinking / tool_use / tool_result 块）。 */
function extractText(content: unknown): string {
  if (isStringContent(content)) return content
  if (isBlockArray(content)) {
    return content
      .filter(
        (b) =>
          b.type !== 'thinking' &&
          b.type !== 'tool_use' &&
          b.type !== 'tool_result',
      )
      .map(blockText)
      .join('')
  }
  return ''
}

/** 拼接 thinking 块文本（assistant 推理噪音）。 */
function extractThinking(content: unknown): string {
  if (isBlockArray(content)) {
    return content.filter((b) => b.type === 'thinking').map(blockThinking).join('')
  }
  return ''
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** 未知 content 的字节数（string 直测，结构化 JSON 序列化后测）。 */
function contentBytes(content: unknown): number {
  if (content === undefined || content === null) return 0
  if (typeof content === 'string') return utf8Bytes(content)
  try {
    return utf8Bytes(JSON.stringify(content))
  } catch {
    return 0
  }
}

interface ToolCallLike {
  name?: unknown
}

function entryToolCallNames(entry: Entry): string[] {
  const msg = entry.message
  if (msg === undefined || msg.toolCalls === undefined || !Array.isArray(msg.toolCalls)) {
    return []
  }
  const names: string[] = []
  for (const tc of msg.toolCalls) {
    if (typeof tc === 'object' && tc !== null && typeof (tc as ToolCallLike).name === 'string') {
      names.push((tc as ToolCallLike).name as string)
    }
  }
  return names
}

/** 该 entry 省略的字节：toolResult 整段 content + assistant 的 thinking 块。 */
function entryOmittedBytes(entry: Entry): number {
  const msg = entry.message
  if (msg === undefined) return 0
  if (msg.role === 'toolResult') return contentBytes(msg.content)
  if (msg.role === 'assistant') return utf8Bytes(extractThinking(msg.content))
  return 0
}

function entryJsonBytes(e: Entry): number {
  try {
    return utf8Bytes(JSON.stringify(e))
  } catch {
    return 0
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

function formatToolSummary(counts: Map<string, number>): string {
  if (counts.size === 0) return ''
  const parts: string[] = []
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${name}×${count}` : name)
  }
  return parts.join(',')
}

// ---------------------------------------------------------------------------
// TurnBrief 计算
// ---------------------------------------------------------------------------

function computeBrief(turn: Turn): TurnBrief {
  const toolCounts = new Map<string, number>()
  let assistantText = ''
  let omitted = 0

  for (const entry of turn.entries) {
    const msg = entry.message
    if (msg !== undefined && msg.role === 'assistant') {
      assistantText += extractText(msg.content)
    }
    for (const name of entryToolCallNames(entry)) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
    }
    omitted += entryOmittedBytes(entry)
  }

  // userBrief：compaction turn 显示 `[compaction] 摘要`；其余取 user text
  let userBrief: string
  if (turn.isCompaction) {
    const first = turn.entries[0]
    const summaryStr = typeof first?.summary === 'string' ? first.summary : ''
    userBrief = truncate('[compaction] ' + summaryStr, 60)
  } else {
    let userText = ''
    for (const entry of turn.entries) {
      const msg = entry.message
      if (msg !== undefined && msg.role === 'user') {
        userText += extractText(msg.content)
      }
    }
    userBrief = truncate(userText, 60)
  }

  return {
    index: turn.index,
    startTime: turn.startTime,
    userBrief,
    toolSummary: formatToolSummary(toolCounts),
    assistantBrief: truncate(assistantText, 80),
    omittedBytes: omitted,
  }
}

/** 在 turn.entries 中找第一个属于 tree.branches 的 forkPointId（用于 allBranches 标注）。 */
function findBranchForkPoint(turn: Turn, tree: TreeView): string | undefined {
  for (const e of turn.entries) {
    if (tree.branches.has(e.id)) return e.id
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 行渲染（预算度量依据）
// ---------------------------------------------------------------------------

function formatHHMM(timestamp?: string): string {
  if (timestamp === undefined) return ''
  const m = timestamp.match(/T(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : ''
}

function formatBytesMarker(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < 1024) return `[${bytes}B omitted]`
  return `[${Math.round(bytes / 1024)}KB omitted]`
}

/**
 * 渲染单行为字符串（用于预算度量与降级判断）。
 * L1 文本行不含 assistantBrief（design §3.5 算法 1 step2：L1 是定位目录，
 * userBrief+toolSummary+omitted 足够；assistant 走 L2/L3）。
 * level: 0=含 toolSummary / 1=骨架（去 toolSummary）。
 */
function formatLine(b: TurnBrief, level: 0 | 1, branchSize?: number): string {
  const parts: string[] = []
  const head = `T${String(b.index).padStart(3, '0')}`
  const time = formatHHMM(b.startTime)
  parts.push(time ? `${head} ${time}` : head)
  if (b.userBrief) parts.push(b.userBrief)
  if (level <= 0 && b.toolSummary) parts.push(b.toolSummary)
  const marker = formatBytesMarker(b.omittedBytes)
  if (marker) parts.push(marker)
  if (branchSize !== undefined && branchSize > 0) parts.push(`[旁支 ${branchSize} entries]`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// renderOutline
// ---------------------------------------------------------------------------

function sumBranchEntries(tree: TreeView): number {
  let s = 0
  for (const n of tree.branches.values()) s += n
  return s
}

/** 计算 parsedBytes（leaf entry JSON 字节和）。totalBytes/totalEntries 由 renderOutline 组装。 */
function leafParsedBytes(turns: Turn[]): number {
  let parsedBytes = 0
  for (const t of turns) {
    for (const e of t.entries) parsedBytes += entryJsonBytes(e)
  }
  return parsedBytes
}

export function renderOutline(
  turns: Turn[],
  tree: TreeView,
  options?: OutlineOptions,
): OutlineResult {
  const budget = options?.budget ?? 2000
  const allBranches = options?.allBranches ?? false
  const granularity = options?.granularity ?? 'turn'

  const parsedBytes = leafParsedBytes(turns)
  const leafEntryCount = turns.reduce((s, t) => s + t.entries.length, 0)
  // totalEntries = leaf + 旁支子树 + 孤儿；totalBytes 无原始文件字节数（签名不含 ParseResult），
  // 以 leaf entry JSON 字节近似，精确值由 M2 工具层用 ParseResult.totalBytes 覆盖。
  const totalEntriesAll = leafEntryCount + sumBranchEntries(tree) + tree.orphans.length
  const stats: OutlineResult['stats'] = {
    totalTurns: turns.length,
    totalEntries: totalEntriesAll,
    totalBytes: parsedBytes,
    parsedBytes,
  }

  if (turns.length === 0) {
    return { turns: [], stats, tokenEstimate: 0 }
  }

  // granularity:entry —— 每 entry 一行，不聚合 turn（D-1 兜底）
  if (granularity === 'entry') {
    return renderEntryGranularity(turns, tree, budget, allBranches, stats)
  }

  // 1. 全量 brief
  const briefs: TurnBrief[] = turns.map(computeBrief)

  // allBranches：标注 forkPoint
  if (allBranches) {
    for (const b of briefs) {
      const fp = findBranchForkPoint(turns[b.index], tree)
      if (fp !== undefined) b.branch = fp
    }
  }

  // 2. perTurnBudget（token → chars×4）
  const perTurnCharBudget = (budget / turns.length) * 4

  // 3. 降级序：L1 行不含 assistantBrief；超预算则砍 toolSummary → 骨架（design §3.5 算法 1 step3）
  const lineCache: string[] = []
  for (const b of briefs) {
    const branchSize = b.branch !== undefined ? tree.branches.get(b.branch) : undefined
    let line = formatLine(b, 0, branchSize)
    if (line.length > perTurnCharBudget) {
      b.toolSummary = ''
      line = formatLine(b, 1, branchSize)
    }
    lineCache.push(line)
  }

  // 4. 总预算截断（从尾部丢弃）
  let totalChars = lineCache.reduce((s, l) => s + l.length, 0)
  let truncated: number | undefined
  if (totalChars / 4 > budget) {
    let kept = lineCache.length
    while (kept > 0 && totalChars / 4 > budget) {
      kept--
      totalChars -= lineCache[kept].length
    }
    truncated = lineCache.length - kept
    lineCache.length = kept
    briefs.length = kept
  }

  const tokenEstimate = Math.ceil(totalChars / 4)
  return { turns: briefs, stats, tokenEstimate, truncated }
}

/** granularity:entry 模式：每 entry 一行 TurnBrief，不聚合，仅总预算截断。 */
function renderEntryGranularity(
  turns: Turn[],
  tree: TreeView,
  budget: number,
  allBranches: boolean,
  stats: OutlineResult['stats'],
): OutlineResult {
  const briefs: TurnBrief[] = []
  let entryIdx = 0
  for (const t of turns) {
    for (const e of t.entries) {
      const msg = e.message
      let text = ''
      if (msg !== undefined && (msg.role === 'user' || msg.role === 'assistant')) {
        text = extractText(msg.content)
      }
      const counts = new Map<string, number>()
      for (const name of entryToolCallNames(e)) {
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      const b: TurnBrief = {
        index: entryIdx++,
        startTime: e.timestamp,
        userBrief: truncate(text, 60) || `[${e.type}]`,
        toolSummary: formatToolSummary(counts),
        assistantBrief: '',
        omittedBytes: entryOmittedBytes(e),
      }
      if (allBranches && tree.branches.has(e.id)) b.branch = e.id
      briefs.push(b)
    }
  }

  const lines = briefs.map((b) =>
    formatLine(b, 0, b.branch !== undefined ? tree.branches.get(b.branch) : undefined),
  )
  let totalChars = lines.reduce((s, l) => s + l.length, 0)
  let truncated: number | undefined
  if (totalChars / 4 > budget) {
    let kept = lines.length
    while (kept > 0 && totalChars / 4 > budget) {
      kept--
      totalChars -= lines[kept].length
    }
    truncated = lines.length - kept
    lines.length = kept
    briefs.length = kept
  }
  return {
    turns: briefs,
    stats,
    tokenEstimate: Math.ceil(totalChars / 4),
    truncated,
  }
}

// ---------------------------------------------------------------------------
// renderExpand（L2 单轮展开）
// ---------------------------------------------------------------------------

export interface EntryBrief {
  index: number
  type: string
  role?: string
  brief: string
  omittedBytes: number
}

function entryBrief(e: Entry): string {
  const msg = e.message
  if (msg !== undefined) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      return truncate(extractText(msg.content), 100) || `[${msg.role}]`
    }
    if (msg.role === 'toolResult') {
      return truncate(extractText(msg.content), 100) || '[tool result]'
    }
  }
  if (e.type === 'compaction') {
    const s = typeof e.summary === 'string' ? e.summary : '[compaction]'
    return truncate(s, 100)
  }
  if (e.type === 'custom') return `[custom:${e.customType ?? 'unknown'}]`
  return `[${e.type}]`
}

export function renderExpand(turn: Turn): {
  turn: string
  entries: EntryBrief[]
} {
  const head = `T${String(turn.index).padStart(3, '0')}`
  const bits = [`${turn.entries.length} entries`]
  if (turn.startTime !== undefined) bits.push(`started ${formatHHMM(turn.startTime)}`)
  if (turn.isCompaction) bits.push('compaction')
  if (turn.userEntry === undefined && !turn.isCompaction) bits.push('preface')
  const header = `${head} (${bits.join(', ')})`

  const entries: EntryBrief[] = turn.entries.map((e, i) => ({
    index: i,
    type: e.type,
    role: e.message?.role,
    brief: entryBrief(e),
    omittedBytes: entryOmittedBytes(e),
  }))
  return { turn: header, entries }
}

// ---------------------------------------------------------------------------
// renderDetail（L3 全文，按 opts 过滤噪音）
// ---------------------------------------------------------------------------

/** 过滤掉 thinking 块；非 block 数组原样返回。 */
function stripThinking(content: unknown): unknown {
  if (!isBlockArray(content)) return content
  return content.filter((b) => b.type !== 'thinking')
}

export function renderDetail(
  turns: Turn[],
  opts: { includeToolResult?: boolean; includeThinking?: boolean } = {},
): Entry[] {
  const includeToolResult = opts.includeToolResult ?? false
  const includeThinking = opts.includeThinking ?? false

  const out: Entry[] = []
  for (const t of turns) {
    for (const e of t.entries) {
      const msg = e.message
      if (msg !== undefined) {
        if (msg.role === 'toolResult' && !includeToolResult) continue
        if (!includeThinking) {
          const cleaned = stripThinking(msg.content)
          if (cleaned !== msg.content) {
            out.push({ ...e, message: { ...msg, content: cleaned } })
            continue
          }
        }
      }
      out.push(e)
    }
  }
  return out
}
