/**
 * entry → TraceRow 映射（A21，design §3.4 渲染模型）。
 *
 * 12 种行 kind + 损坏行占位；行摘要为「数据提取」（headline + meta 标量），
 * 不做 i18n 文案（trace-i18n 单元职责）；inspector 详情消费原始 entry 透传。
 * inContext / shadowed 由 context-boundary 计算（探针 P4 语义）。
 */
import { computeTraceContextBoundary } from './context-boundary'
import type {
  ParsedSessionTraceLine,
} from './parse-jsonl'
import type {
  TraceAgentMessage,
  TraceFileEntry,
  TraceRowKind,
  TraceSessionEndMeta,
  TraceSessionEntry,
} from './types'

/** xyz-agent system prompt 留痕 customType（trace-ext 单元的写入约定，design D2）。 */
export const SYSTEM_PROMPT_CUSTOM_TYPE = 'xyz:system-prompt'

/** 行摘要 meta：kind 无关的标量字段包（UI 直接展示；值限标量或标量数组）。 */
export type TraceRowMeta = Record<string, string | number | boolean | undefined>

/** 台账行（§3.4：一行 = 一个 entry；损坏行/sidecar 终态行也有行）。 */
export interface TraceRow {
  /** 稳定 key：entry id；无 id 行用 `line:N`；损坏行 `malformed:N`；sidecar `sidecar:session_end`。 */
  key: string
  /** 1-based 台账序号（含损坏行与 sidecar 行，全量连续）。 */
  seq: number
  kind: TraceRowKind
  /** JSONL 行号（1-based；sidecar 行无）。 */
  lineNumber?: number
  timestamp?: string
  /** 进当前 LLM context（buildContextEntries ∩ 转换非空）。 */
  inContext: boolean
  /** 影子化（在 leaf 路径、可进类型、被 compaction 排除）。不可进类型恒 false。 */
  shadowed: boolean
  /** 行首摘要（纯数据提取，非 i18n 文案；UI 渲染态标题）。 */
  headline: string
  /** 关键标量字段（模型/exitCode/tokensBefore/thinkingLevel/customType/display…）。 */
  meta: TraceRowMeta
  /** 来源 entry（inspector 详情；MALFORMED 无；sidecar 行为 session_end 元数据）。 */
  entry?: TraceFileEntry | TraceSessionEndMeta
  /** 损坏行原文（仅 MALFORMED）。 */
  raw?: string
  /** 行来源：JSONL 文件行 / sidecar .meta.json（session_end 不污染 JSONL）。 */
  source: 'jsonl' | 'sidecar'
}

/** mapSessionTraceRows 输入。 */
export interface SessionTraceInput {
  /** JSONL 逐行解析产物（含 header / handoff_marker / 损坏行占位）。 */
  lines: ParsedSessionTraceLine[]
  /** sidecar session_end（runtime 读 `.jsonl.meta.json` 后传入；core 不读文件）。 */
  sessionEnd?: TraceSessionEndMeta
  /**
   * leaf entry id（活跃 session 路径 A：RPC get_entries 的 leafId）。
   * undefined = 尾部 entry fallback（文件直读路径 B 无 leaf 概念时的 pi 默认行为）。
   */
  leafId?: string
}

/** entry → 行 kind（§3.4 映射表；独立导出供单测/复用）。 */
export function resolveTraceRowKind(entry: TraceFileEntry): TraceRowKind {
  switch (entry.type) {
    case 'session':
      return 'SESSION'
    case 'compaction':
      return 'COMPACTED'
    case 'branch_summary':
      return 'BRANCH'
    case 'custom_message':
      return 'NOTICE'
    case 'model_change':
    case 'thinking_level_change':
    case 'session_info':
    case 'label':
      return 'LIFECYCLE'
    case 'handoff_marker':
      return 'BOUNDARY'
    case 'custom':
      return (entry as { customType?: unknown }).customType === SYSTEM_PROMPT_CUSTOM_TYPE
        ? 'SYSTEM'
        : 'DATA'
    case 'message': {
      const role = (entry as { message?: TraceAgentMessage }).message?.role
      switch (role) {
        case 'user':
          return 'USER'
        case 'assistant':
          return 'ASSISTANT'
        case 'toolResult':
          return 'TOOL'
        case 'bashExecution':
          return 'BASH'
        case 'custom':
          return 'NOTICE'
        default:
          // 未知 role 的 message：类型上可进 context（转换非空），归消息类兜底 NOTICE
          return 'NOTICE'
      }
    }
    default:
      // pi 未来新增/未建模 entry：不可进 context，按纯数据兜底（不丢失，G1）
      return 'DATA'
  }
}

/** 取 content 中第一段可读文本（text block 或 string content），供 USER/NOTICE headline。 */
function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text
      }
    }
  }
  return ''
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** 单行摘要：headline + meta（数据提取；空 headline 由 UI 以 kind 标签兜底）。 */
function summarizeRow(entry: TraceFileEntry | TraceSessionEndMeta, kind: TraceRowKind): { headline: string; meta: TraceRowMeta } {
  const meta: TraceRowMeta = {}
  switch (kind) {
    case 'SESSION': {
      const h = entry as TraceFileEntry & { cwd?: unknown; parentSession?: unknown; forkEntryId?: unknown }
      meta.cwd = str(h.cwd)
      if (h.parentSession !== undefined) meta.parentSession = str(h.parentSession)
      if (h.forkEntryId !== undefined) meta.forkEntryId = str(h.forkEntryId)
      return { headline: str(h.cwd), meta }
    }
    case 'SYSTEM': {
      const d = (entry as { data?: unknown }).data
      const rec = typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {}
      meta.version = num(rec.version)
      meta.reason = str(rec.reason) || undefined
      meta.hash = str(rec.hash) || undefined
      meta.charCount = num(rec.charCount)
      return { headline: `system prompt v${rec.version ?? '?'}`, meta }
    }
    case 'USER': {
      const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
      return { headline: firstText(m.content), meta }
    }
    case 'ASSISTANT': {
      const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
      meta.provider = str(m.provider) || undefined
      meta.model = str(m.model) || undefined
      meta.stopReason = str(m.stopReason) || undefined
      let thinking = 0
      let tool = 0
      let text = 0
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          const t = typeof b === 'object' && b !== null ? (b as { type?: unknown }).type : undefined
          if (t === 'thinking') thinking++
          else if (t === 'toolCall') tool++
          else if (t === 'text') text++
        }
      }
      meta.thinkingBlocks = thinking
      meta.toolCalls = tool
      meta.textBlocks = text
      return { headline: str(m.model) || str(m.provider), meta }
    }
    case 'TOOL': {
      const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
      meta.toolName = str(m.toolName) || undefined
      meta.toolCallId = str(m.toolCallId) || undefined
      meta.isError = bool(m.isError)
      return { headline: str(m.toolName), meta }
    }
    case 'BASH': {
      const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
      meta.command = str(m.command) || undefined
      meta.exitCode = num(m.exitCode)
      meta.cancelled = bool(m.cancelled)
      meta.truncated = bool(m.truncated)
      meta.fullOutputPath = str(m.fullOutputPath) || undefined
      return { headline: str(m.command), meta }
    }
    case 'NOTICE': {
      if (entry.type === 'custom_message') {
        const e = entry as TraceFileEntry & { customType?: unknown; display?: unknown }
        meta.customType = str(e.customType) || undefined
        meta.display = bool(e.display)
        return { headline: str(e.customType), meta }
      }
      const m = (entry as { message?: TraceAgentMessage }).message ?? ({} as TraceAgentMessage)
      meta.customType = str(m.customType) || undefined
      meta.display = bool(m.display)
      return { headline: str(m.customType), meta }
    }
    case 'COMPACTED': {
      const e = entry as TraceFileEntry & { tokensBefore?: unknown; firstKeptEntryId?: unknown; fromHook?: unknown }
      meta.tokensBefore = num(e.tokensBefore)
      meta.firstKeptEntryId = str(e.firstKeptEntryId) || undefined
      meta.fromHook = bool(e.fromHook)
      return { headline: `compaction (${num(e.tokensBefore) ?? '?'} tok before)`, meta }
    }
    case 'BRANCH': {
      const e = entry as TraceFileEntry & { fromId?: unknown }
      meta.fromId = str(e.fromId) || undefined
      return { headline: `branch from ${str(e.fromId) || '?'}`, meta }
    }
    case 'LIFECYCLE': {
      switch (entry.type) {
        case 'model_change': {
          const e = entry as TraceFileEntry & { provider?: unknown; modelId?: unknown }
          meta.provider = str(e.provider) || undefined
          meta.modelId = str(e.modelId) || undefined
          return { headline: `${str(e.provider)}/${str(e.modelId)}`, meta }
        }
        case 'thinking_level_change': {
          const e = entry as TraceFileEntry & { thinkingLevel?: unknown }
          meta.thinkingLevel = str(e.thinkingLevel) || undefined
          return { headline: `thinking: ${str(e.thinkingLevel) || '?'}`, meta }
        }
        case 'session_info': {
          const e = entry as TraceFileEntry & { name?: unknown }
          meta.name = str(e.name) || undefined
          return { headline: `rename: ${str(e.name) || '?'}`, meta }
        }
        case 'label': {
          const e = entry as TraceFileEntry & { targetId?: unknown; label?: unknown }
          meta.targetId = str(e.targetId) || undefined
          meta.label = str(e.label) || undefined
          return { headline: `label ${str(e.label) || '(cleared)'} → ${str(e.targetId) || '?'}`, meta }
        }
        default:
          return { headline: entry.type, meta }
      }
    }
    case 'DATA': {
      const e = entry as TraceFileEntry & { customType?: unknown }
      meta.customType = str(e.customType) || undefined
      return { headline: str(e.customType) || entry.type, meta }
    }
    case 'BOUNDARY': {
      if (entry.type === 'handoff_marker') {
        const e = entry as TraceFileEntry & { handedOffTo?: unknown }
        meta.handedOffTo = str(e.handedOffTo) || undefined
        return { headline: `handoff → ${str(e.handedOffTo) || '?'}`, meta }
      }
      const e = entry as TraceSessionEndMeta
      meta.outcome = e.outcome
      meta.reason = e.reason
      return { headline: `session end: ${e.outcome}`, meta }
    }
    default:
      return { headline: '', meta }
  }
}

/**
 * JSONL 逐行产物 + sidecar → 台账行数组。
 *
 * 行序 = 文件行序（损坏行占位在原位）；sidecar session_end 追加尾部。
 * inContext/shadowed 语义见 context-boundary；无 id 行（handoff_marker、畸形 entry）无法
 * 匹配 context 集合，恒为 false（不可进类型语义本就如此）。
 */
export function mapSessionTraceRows(input: SessionTraceInput): TraceRow[] {
  const { lines, sessionEnd, leafId } = input

  // boundary 输入 = 排除 header 的全部 ok entry（pi getEntries 语义；handoff_marker 等自定义行保留——
  // 忠实复刻 pi 把它们当 loose entry 参与尾 fallback 的行为）
  const entriesForBoundary: TraceSessionEntry[] = []
  for (const line of lines) {
    if (line.ok && line.entry.type !== 'session') {
      entriesForBoundary.push(line.entry as TraceSessionEntry)
    }
  }
  const boundary = computeTraceContextBoundary(entriesForBoundary, leafId)

  const rows: TraceRow[] = []
  let seq = 0
  for (const line of lines) {
    seq++
    if (!line.ok) {
      rows.push({
        key: `malformed:${line.lineNumber}`,
        seq,
        kind: 'MALFORMED',
        lineNumber: line.lineNumber,
        inContext: false,
        shadowed: false,
        headline: `unparseable line #${line.lineNumber}`,
        meta: {},
        raw: line.raw,
        source: 'jsonl',
      })
      continue
    }
    const entry = line.entry
    const kind = resolveTraceRowKind(entry)
    const { headline, meta } = summarizeRow(entry, kind)
    const id = entry.id
    rows.push({
      key: id !== undefined && id !== '' ? id : `line:${line.lineNumber}`,
      seq,
      kind,
      lineNumber: line.lineNumber,
      timestamp: entry.timestamp,
      inContext: id !== undefined && id !== '' ? boundary.contextEntryIds.has(id) : false,
      shadowed: id !== undefined && id !== '' ? boundary.shadowedEntryIds.has(id) : false,
      headline,
      meta,
      entry,
      source: 'jsonl',
    })
  }

  if (sessionEnd !== undefined) {
    seq++
    const kind = 'BOUNDARY' as const
    const { headline, meta } = summarizeRow(sessionEnd, kind)
    rows.push({
      key: 'sidecar:session_end',
      seq,
      kind,
      timestamp: sessionEnd.timestamp,
      inContext: false,
      shadowed: false,
      headline,
      meta,
      entry: sessionEnd,
      source: 'sidecar',
    })
  }

  return rows
}
