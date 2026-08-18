/**
 * message-converter —— 历史路径 entry → Message 转换的 wire 层（data-source-governance W20）。
 *
 * [W20 架构位] 派生规则（content parts 解析 / skill 剖离 / toolResult 配对 / compaction /
 * branchSummary / custom / bashExecution / fileChanges / usage）已全部迁入 core reducer：
 * packages/core/src/domain/chat/apply-entry.ts（applyEntry —— D5 单一 reducer，D7 投影一次）。
 * 本文件保留 wire 层职责：RPC reply / JSONL 读到的原始形态 → pi entry 列表（liftHistoryToEntries）
 * → 喂 core reducer → Message[]。
 *
 * 相对路径 import core 说明：runtime 包依赖图不含 @xyz-agent/core（core 依赖 vue/pinia，
 * 加包级依赖会把 vue 拉进 runtime bundle）；apply-entry.ts 是自包含纯函数模块（只依赖
 * @xyz-agent/shared，tsup 已随 noExternal 打包 shared），相对路径引用使派生规则单点化。
 * W21/W22 若把 reducer 输入上收到 protocol 层，可重新评估包边界（如 shared 收敛）。
 *
 * [迁移期双实现] convertPiHistoryLegacy = 迁移前实现逐字保留，仅供 W20 等价性迁移防线测试
 * （packages/core/src/domain/chat/__tests__/apply-entry-equivalence.test.ts 断言新旧 deep equal）
 * 消费；W21 断言升级后随 live-reload 一起删除，勿在新代码引用。
 *
 * 实时路径（event-adapter.ts）不在本文件历史路径管辖内（W21 领地）。
 */
import type {
  PiHistoryMessage,
  PiHistoryToolResult,
} from './pi-protocol.js'
import type { Message, ThinkingBlock, ToolCall, FileChange, Segment } from '@xyz-agent/shared'
import { textToSegments } from '@xyz-agent/shared'
import { normalizePiToolResult } from './normalize-tool-result.js'
import {
  applyEntry,
  createInitialChatViewState,
  replayEntries,
} from '../../../../core/src/domain/chat/apply-entry.js'
import type { PiEntry, PiMessageEntry } from '../../../../core/src/domain/chat/apply-entry.js'

// ════════════════════════════════════════════════════════════════════
// 新路径：wire lift + core reducer（W20 起的历史路径唯一生产实现）
// ════════════════════════════════════════════════════════════════════

/**
 * 把历史读取链路拿到的伪消息列表 lift 为 pi message entry 形态（wire 层职责：RPC reply → entry 列表）。
 *
 * 输入形态（mapSessionEntries 产出的伪消息 / get_messages 扁平列表 / JSONL 提取）全部包成
 * message entry——pi AgentMessage 联合本身含 toolResult/bashExecution/compactionSummary/custom/
 * branchSummary role（与专用 entry 类型双形态存储），role 细分语义归 reducer 的 message case。
 *
 * entryId 解析优先级与迁移前一致：平行 entryIds[i] > 消息体 __entryId（文件路径旧注入）；
 * 都缺失时 entry 不带 id（reducer 不回填 piEntryId，piEntryId 缺失语义与迁移前一致）。
 *
 * 缺失 timestamp 的兜底（Date.now）在 lift 时落定——与迁移前同点位，保证 reducer 输入
 * 确定后输出确定（reducer 内部无 Date.now / randomUUID）。
 *
 * 导出供等价性测试（lift 保真断言）消费，生产调用方只有 convertPiHistory。
 */
export function liftHistoryToEntries(raw: unknown[], entryIds?: string[]): PiEntry[] {
  const entries: PiEntry[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'object' || item === null) {
      console.warn(`[message-converter] skipping non-object history item at index ${i}`)
      continue
    }
    const rec = item as Record<string, unknown>
    const inlineId = typeof rec.__entryId === 'string' ? rec.__entryId : undefined
    const entryId = entryIds?.[i] ?? inlineId
    const tsMs = typeof rec.timestamp === 'number' ? rec.timestamp : Date.now()
    const entry: PiMessageEntry = {
      type: 'message',
      ...(entryId !== undefined && { id: entryId }),
      parentId: null,
      timestamp: new Date(tsMs).toISOString(),
      message: rec,
    }
    entries.push(entry)
  }
  return entries
}

/**
 * 转换单条 pi message 为 xyz-agent Message（W20 起经 core reducer；保留导出供
 * message-converter-order.test 的 contentBlocks 顺序回归与潜在外部消费者）。
 *
 * 仅处理 user/assistant message。未知 role 在 reducer 内 warn + 跳过（返回 null）。
 *
 * @param m pi history message
 * @param options 可选 entryId（填到 msg.piEntryId；缺省时回退读 m.__entryId）
 */
export function convertSinglePiMessage(
  m: PiHistoryMessage,
  options?: { entryId?: string },
): Message | null {
  const inlineId = '__entryId' in m && typeof (m as { __entryId?: unknown }).__entryId === 'string'
    ? (m as { __entryId: string }).__entryId
    : undefined
  const entryId = options?.entryId ?? inlineId
  const entry: PiMessageEntry = {
    type: 'message',
    ...(entryId !== undefined && { id: entryId }),
    parentId: null,
    timestamp: new Date(m.timestamp ?? Date.now()).toISOString(),
    message: m,
  }
  const state = applyEntry(createInitialChatViewState(), entry)
  return state.messages.length > 0 ? state.messages[0] : null
}

/**
 * Convert pi message list into frontend Message[], merging toolResult
 * entries into their parent assistant message's matching toolCall.
 *
 * [W20] 实现 = liftHistoryToEntries（wire lift）+ replayEntries（core reducer fold）。
 * 签名与行为契约不变（等价性由 apply-entry-equivalence.test 对 legacy 断言锁定）：
 *
 * 签名收 unknown[]：pi 的历史结构（PiHistoryMessage/PiHistoryToolResult）是 pi 协议类型，
 * 只在此 infra 文件内部断言，不暴露给 service。service 传 RPC/文件读到的原始 JSON 即可。
 *
 * @param raw pi history message 列表（get_messages 返回 / JSONL 读取 / entry 树提取）
 * @param entryIds 可选，与 raw 一一对应的 entry id 列表（entry 树重建路径用）。
 *   传时 user/assistant message 会带上 piEntryId（按 index 取 entryIds[i]）。
 * @param orphanToolResults 可选 out 数组：窗口内无法配对的 toolResult（无 preceding
 *   assistant 或其 toolCalls 无匹配 toolCallId）push 进来供增量合并阶段回填
 *   （W20 review Fix-1）。不传时保持原行为（warn 丢弃）——全量窗口正常时序无孤儿。
 */
export function convertPiHistory(raw: unknown[], entryIds?: string[], orphanToolResults?: PiHistoryToolResult[]): Message[] {
  const state = replayEntries(liftHistoryToEntries(raw, entryIds))
  if (orphanToolResults !== undefined) {
    for (const orphan of state.orphanToolResults) {
      // orphan 已由 reducer 按 role==='toolResult' 收窄构造（apply-entry.ts toolResult 分支），
      // 此处断言只还原「宽形态 body → pi 协议类型」的静态差异，字段集运行时一致。
      orphanToolResults.push(orphan as PiHistoryToolResult)
    }
  }
  return state.messages
}

/**
 * 把增量窗口的孤儿 toolResult 按 toolCallId 回填到已合并消息列表的 assistant toolCall
 * （W20 review Fix-1）。reducer fold 后的增量合并阶段调用；匹配不到 warn 丢弃。
 *
 * 签名收 unknown[]（与 convertPiHistory 同模式）：pi 结构只在此 infra 文件内部断言。
 */
export function applyOrphanToolResults(messages: Message[], orphanToolResults: unknown[]): void {
  for (const raw of orphanToolResults) {
    const toolResult = raw as PiHistoryToolResult
    let matched: ToolCall | undefined
    for (const m of messages) {
      matched = m.toolCalls?.find(t => t.id === toolResult.toolCallId)
      if (matched) break
    }
    if (matched) {
      fillToolCallOutput(matched, toolResult)
    } else {
      console.warn('[message-converter] orphan toolResult has no matching toolCall in merged messages:', toolResult.toolCallId)
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// 迁移期参照实现（W20 等价性防线专用，W21 删除）
// ════════════════════════════════════════════════════════════════════

/**
 * [迁移期参照] 把 toolResult 归一回填到单个 toolCall（迁移前实现，供 legacy 家族与
 * applyOrphanToolResults 共用——后者是生产路径，语义必须与迁移前逐字一致）。
 */
function fillToolCallOutput(tc: ToolCall, toolResult: PiHistoryToolResult): void {
  // 对称恢复 outputRaw（规则 7.5：对话流状态必须可重开恢复）。
  // 实时路径（event-adapter handleToolExecutionEnd）已统一委托 normalizePiToolResult（W1），
  // 此处历史路径对称：output 存 stripAnsi 版本，outputRaw 存原始 ANSI 文本（仅当含 ANSI 时）。
  const { output, outputRaw } = normalizePiToolResult(toolResult)
  tc.output = output
  if (outputRaw) tc.outputRaw = outputRaw
  if (toolResult.isError) tc.status = 'error'
  // F1 修复：透传 details（含 __gui__），与实时路径（event-interpreter tool_call_end）对齐。
  // 规则 7.5：对话流状态必须可重开恢复——重开 session 后 __gui__ 不丢。
  if (toolResult.details && typeof toolResult.details === 'object' && !Array.isArray(toolResult.details)) {
    tc.details = toolResult.details
  }
}

/**
 * [迁移期参照] Parse `<skill name="xxx" location="...">...</skill>` blocks from
 * a user message's text content（迁移前实现逐字保留）。
 */
function parseSkillBlockLegacy(text: string): Segment[] | null {
  const match = text.match(/<skill\s+name="([^"]+)"(?:\s+location="([^"]+)")?[^>]*>[\s\S]*?<\/skill>([\s\S]*)$/)
  if (!match) return null
  // Segment 类型的 skill 变体本身已有 location?: string 字段（shared/segments.ts:26），
  // 构造时直接带 location，无需运行时断言赋值。
  const skillSeg: Segment = match[2]
    ? { type: 'skill', name: match[1], location: match[2] }
    : { type: 'skill', name: match[1] }
  const segments: Segment[] = [skillSeg]
  const userText = match[3].trim()
  if (userText) {
    segments.push({ type: 'text', text: userText })
  }
  return segments
}

// [迁移期参照] write/edit 工具名集合（迁移前实现；新实现在 core apply-entry.ts）。
const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'writeFile', 'create_file'])
const EDIT_TOOL_NAMES = new Set(['edit', 'edit_file', 'editFile', 'str_replace', 'replace'])

/**
 * [迁移期参照] 从历史 assistant 消息的 toolCalls 提取 fileChanges（迁移前实现）。
 *
 * 历史路径无 cwd 做 existsSync 判定（write added/modified 无法区分），
 * 按 AC-9.3 graceful 降级：write 一律标 modified（方案 B 兜底，与 event-adapter 缺 cwd 时一致），
 * edit 恒 modified。filePath 取 toolCall.arguments.path（pi 契约权威参数名，file_path 防御 fallback）。
 */
function extractHistoryFileChangesLegacy(toolCalls: ToolCall[]): FileChange[] {
  const changes: FileChange[] = []
  const seen = new Set<string>()
  for (const tc of toolCalls) {
    const isWrite = WRITE_TOOL_NAMES.has(tc.toolName)
    const isEdit = EDIT_TOOL_NAMES.has(tc.toolName)
    if (!isWrite && !isEdit) continue
    const args = (tc.input ?? {}) as Record<string, unknown>
    const filePath = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : ''
    if (!filePath || seen.has(filePath)) continue
    seen.add(filePath)
    // write 历史无 cwd 无法判 added/modified，一律 modified（graceful，AC-9.3）；edit 恒 modified
    changes.push({ filePath, status: 'modified' })
  }
  return changes
}

/**
 * [迁移期参照] 迁移前 convertSinglePiMessage 逐字保留（legacy 家族内部使用）。
 */
function convertSinglePiMessageLegacy(
  m: PiHistoryMessage,
  options?: { entryId?: string },
): Message | null {
  // W11：显式拒绝未知 role，避免把任何非 user 也非已处理特殊类型的 entry 默认归入 assistant
  if (m.role !== 'user' && m.role !== 'assistant') {
    console.warn(`[message-converter] unknown role: ${String(m.role)}, skipping`)
    return null
  }
  const parts = Array.isArray(m.content)
    ? m.content
    : [{ type: 'text' as const, text: m.content != null ? String(m.content) : '' }]
  let textContent = ''
  const thinking: ThinkingBlock[] = []
  const toolCalls: ToolCall[] = []
  const contentBlocks: import('@xyz-agent/shared').ContentBlock[] = []
  let hasTextBlock = false

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.type === 'text') {
      textContent += part.text ?? ''
      if (!hasTextBlock) {
        hasTextBlock = true
        contentBlocks.push({ type: 'text', refId: 'text', contentIndex: i })
      }
    } else if (part.type === 'thinking') {
      const thkId = crypto.randomUUID()
      thinking.push({
        id: thkId,
        content: part.thinking ?? '',
        collapsed: true,
      })
      contentBlocks.push({ type: 'thinking', refId: thkId, contentIndex: i })
    } else if (part.type === 'toolCall' || part.type === 'tool_use') {
      const tcId = part.id ?? crypto.randomUUID()
      toolCalls.push({
        id: tcId,
        toolName: part.name ?? '',
        input: part.arguments ?? {},
        status: 'completed',
        startTime: m.timestamp ?? Date.now(),
      })
      contentBlocks.push({ type: 'toolCall', refId: tcId, contentIndex: i })
    }
  }

  const resolvedEntryId = options?.entryId
    ?? ('__entryId' in m && typeof (m as { __entryId?: unknown }).__entryId === 'string'
      ? (m as { __entryId: string }).__entryId
      : undefined)

  const msg: Message = {
    id: crypto.randomUUID(),
    role: m.role === 'user' ? 'user' : 'assistant',
    content: textContent,
    status: 'complete',
    ...(resolvedEntryId !== undefined && { piEntryId: resolvedEntryId }),
    ...(thinking.length > 0 && { thinking }),
    ...(toolCalls.length > 0 && { toolCalls }),
    ...(contentBlocks.length > 0 && { contentBlocks }),
    ...(m.role === 'assistant' && toolCalls.length > 0 && (() => {
      const fc = extractHistoryFileChangesLegacy(toolCalls)
      return fc.length > 0 ? { fileChanges: fc } : {}
    })()),
    ...(() => {
      if (m.role !== 'assistant') return {}
      const u = (m as { usage?: { input?: number; output?: number } }).usage
      return u ? { usage: { inputTokens: u.input ?? 0, outputTokens: u.output ?? 0 } } : {}
    })(),
    timestamp: m.timestamp ?? Date.now(),
  }

  if (m.role === 'user' && textContent) {
    const parsed = parseSkillBlockLegacy(textContent)
    if (parsed) {
      msg.content = parsed
    } else {
      msg.content = textToSegments(textContent)
    }
  }
  return msg
}

/**
 * [迁移期参照] 迁移前 convertPiHistory 逐字保留。
 *
 * 唯一消费方：packages/core/src/domain/chat/__tests__/apply-entry-equivalence.test.ts
 * （W20 等价性迁移防线——同 fixture 序列下新旧路径 messages deep equal）。
 * W21 断言升级为 store 级 live≡reload 后删除本函数与上方 legacy 家族。
 */
export function convertPiHistoryLegacy(raw: unknown[], entryIds?: string[], orphanToolResults?: PiHistoryToolResult[]): Message[] {
  const result: Message[] = []
  let lastAssistantWithToolCalls = -1

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const m = item as PiHistoryMessage | PiHistoryToolResult | { role: 'compactionSummary'; summary?: string; tokensBefore?: number; timestamp?: number } | { role: 'custom'; customType: string; content?: string; details?: Record<string, unknown>; timestamp?: number } | { role: 'branchSummary'; summary?: string; fromId?: string; timestamp?: number } | { role: 'bashExecution'; command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean; excludeFromContext?: boolean; timestamp: number; fullOutputPath?: string }
    if (m.role === 'toolResult') {
      const toolResult = m as PiHistoryToolResult
      const tc = lastAssistantWithToolCalls >= 0
        ? result[lastAssistantWithToolCalls]?.toolCalls?.find(t => t.id === toolResult.toolCallId)
        : undefined
      if (tc) {
        fillToolCallOutput(tc, toolResult)
      } else {
        orphanToolResults?.push(toolResult)
        console.warn('[message-converter] toolResult has no matching toolCall in window:', toolResult.toolCallId)
      }
      continue
    }

    if (m.role === 'compactionSummary') {
      const cm = m as { role: 'compactionSummary'; summary?: string; tokensBefore?: number; timestamp?: number }
      result.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: cm.summary ?? '上下文已压缩',
        status: 'complete',
        compactionSummary: {
          summary: cm.summary,
          tokensBefore: cm.tokensBefore,
          timestamp: cm.timestamp ?? Date.now(),
        },
        timestamp: cm.timestamp ?? Date.now(),
      })
      continue
    }

    if (m.role === 'custom') {
      const cm = m as {
        role: 'custom'
        customType: string
        content?: string
        details?: Record<string, unknown>
        timestamp?: number
        display?: boolean
      }
      const msg: Message = {
        id: crypto.randomUUID(),
        role: 'system',
        content: cm.content ?? '',
        status: 'complete',
        customType: cm.customType,
        details: cm.details as Record<string, unknown> | undefined,
        timestamp: cm.timestamp ?? Date.now(),
        display: cm.display,
      }
      result.push(msg)
      continue
    }

    if (m.role === 'branchSummary') {
      const bm = m as { role: 'branchSummary'; summary?: string; fromId?: string; timestamp?: number }
      result.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: bm.summary ?? '',
        status: 'complete',
        branchSummary: {
          summary: bm.summary,
          fromId: bm.fromId,
          timestamp: bm.timestamp ?? Date.now(),
        },
        timestamp: bm.timestamp ?? Date.now(),
      })
      continue
    }

    if (m.role === 'bashExecution') {
      const bm = m as { role: 'bashExecution'; command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean; excludeFromContext?: boolean; timestamp?: number; fullOutputPath?: string }
      const ts = bm.timestamp ?? Date.now()
      result.push({
        id: crypto.randomUUID(),
        role: 'system',
        content: '',
        status: 'complete',
        timestamp: ts,
        bashExecution: {
          command: bm.command,
          output: bm.output,
          exitCode: bm.exitCode ?? null,
          cancelled: bm.cancelled,
          truncated: bm.truncated,
          excludeFromContext: !!bm.excludeFromContext,
          timestamp: ts,
          ...(bm.fullOutputPath !== undefined && { fullOutputPath: bm.fullOutputPath }),
        },
      } satisfies Message)
      continue
    }

    const entryId = entryIds?.[i]
    const msg = convertSinglePiMessageLegacy(m as PiHistoryMessage, entryId !== undefined ? { entryId } : undefined)
    if (!msg) continue
    result.push(msg)
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lastAssistantWithToolCalls = result.length - 1
    }
  }

  return result
}
