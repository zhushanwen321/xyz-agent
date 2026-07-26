import type {
  PiHistoryMessage,
  PiHistoryToolResult,
} from './pi-protocol.js'
import type { Message, ThinkingBlock, ToolCall, FileChange, Segment } from '@xyz-agent/shared'
import { parseBgNotifyDetails, textToSegments } from '@xyz-agent/shared'
import { normalizePiToolResult } from './normalize-tool-result.js'

/**
 * Parse `<skill name="xxx" location="...">...</skill>` blocks from
 * a user message's text content. Returns the extracted skill name and the
 * remaining user text (everything after the closing `</skill>` tag).
 * Returns `null` if no skill block is found.
 */
function parseSkillBlock(text: string): Segment[] | null {
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

/**
 * [W6 #9 G5] 从历史 assistant 消息的 toolCalls 提取 fileChanges（write/edit 工具）。
 *
 * 历史路径无 cwd 做 existsSync 判定（write added/modified 无法区分），
 * 按 AC-9.3 graceful 降级：write 一律标 modified（方案 B 兜底，与 event-adapter 缺 cwd 时一致），
 * edit 恒 modified。filePath 取 toolCall.arguments.path（pi 契约权威参数名，file_path 防御 fallback）。
 *
 * 与实时路径语义对齐（都按"工具改了哪些文件"判定），但两条路径实现不同：
 * - 实时路径（event-adapter）：ADR-0024 D5 后改用 git baseline diff（file-change-reconciler），
 *   覆盖 write/edit/bash（bash 经 sed/echo 改的文件无法静态解析，只能靠 diff 兜底），并计算行数。
 * - 历史路径（此处）：从 toolCall 参数静态解析（无法覆盖 bash），且不计算行数
 *   （patch 不在历史 toolCall 里，需 toolResult 解析，复杂度高且非 file-tree 主链路，留 TODO）。
 */
// 下方 write/edit 工具名集合与 event-adapter 的实时 diff 触发条件（write/edit/bash）刻意不复用：
// 此处面向历史 toolCall 静态解析，历史数据工具名更杂（含 write_file/str_replace 等别名）故需宽匹配，
// 且历史无 bash（bash 改的文件无法从参数静态解析，历史路径无法还原）。
const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'writeFile', 'create_file'])
const EDIT_TOOL_NAMES = new Set(['edit', 'edit_file', 'editFile', 'str_replace', 'replace'])

function extractHistoryFileChanges(toolCalls: ToolCall[]): FileChange[] {
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
 * 转换单条 pi message 为 xyz-agent Message（从 convertPiHistory 抽出，供 entry-tree-builder 复用）。
 *
 * 仅处理 user/assistant message（toolResult/compactionSummary/custom/branchSummary 等特殊 role
 * 仍由 convertPiHistory 内部分支处理——这些类型不是 message entry 的 message 字段，不进本 helper）。
 *
 * @param m pi history message（user/assistant/toolResult 任一，但只有 user/assistant 产出 Message）
 * @param options 可选上下文：
 *   - entryId：从 entry 树重建时传入，填到 msg.piEntryId（替代从 __entryId 读，entry-tree-builder 路径用）
 * @returns user/assistant → Message；未知 role → null（调用方跳过）
 */
export function convertSinglePiMessage(
  m: PiHistoryMessage,
  options?: { entryId?: string },
): Message | null {
  // W11：显式拒绝未知 role，避免把任何非 user 也非已处理特殊类型的 entry 默认归入 assistant
  // （旧实现 `m.role === 'user' ? 'user' : 'assistant'` 把未知 role 当 assistant，掩盖数据异常）。
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

  for (const part of parts) {
    if (part.type === 'text') {
      textContent += part.text ?? ''
      // text 块按真实到达顺序 push（首次遇到时 push 一次，多次 text part 只累加不重复 push）。
      if (!contentBlocks.some((b) => b.type === 'text')) {
        contentBlocks.push({ type: 'text', refId: 'text' })
      }
    } else if (part.type === 'thinking') {
      const thkId = crypto.randomUUID()
      thinking.push({
        id: thkId,
        content: part.thinking ?? '',
        collapsed: true,
      })
      contentBlocks.push({ type: 'thinking', refId: thkId })
    } else if (part.type === 'toolCall' || part.type === 'tool_use') {
      const tcId = part.id ?? crypto.randomUUID()
      toolCalls.push({
        id: tcId,
        toolName: part.name ?? '',
        input: part.arguments ?? {},
        status: 'completed',
        startTime: m.timestamp ?? Date.now(),
      })
      contentBlocks.push({ type: 'toolCall', refId: tcId })
    }
  }

  // piEntryId 解析：options.entryId 优先（entry-tree-builder 路径），
  // 否则回退读 m.__entryId（convertPiHistory 文件路径，session-history 注入）。
  const resolvedEntryId = options?.entryId
    ?? ('__entryId' in m && typeof (m as { __entryId?: unknown }).__entryId === 'string'
      ? (m as { __entryId: string }).__entryId
      : undefined)

  const msg: Message = {
    id: crypto.randomUUID(),
    role: m.role === 'user' ? 'user' : 'assistant',
    content: textContent,
    status: 'complete',
    // 文件路径读取时 session-history 注入的 pi entry id（fork 定位截断点用）。
    // RPC 路径无此字段，fork 时 fallback 读 JSONL 按 timestamp 匹配。
    ...(resolvedEntryId !== undefined && { piEntryId: resolvedEntryId }),
    ...(thinking.length > 0 && { thinking }),
    ...(toolCalls.length > 0 && { toolCalls }),
    ...(contentBlocks.length > 0 && { contentBlocks }),
    // [W6 #9 G5] 历史路径还原 fileChanges（write/edit 工具提取，AC-9.1/9.3）
    ...(m.role === 'assistant' && toolCalls.length > 0 && (() => {
      const fc = extractHistoryFileChanges(toolCalls)
      return fc.length > 0 ? { fileChanges: fc } : {}
    })()),
    // Extract usage from pi assistant messages (input/output token counts)
    ...(() => {
      if (m.role !== 'assistant') return {}
      const u = (m as { usage?: { input?: number; output?: number } }).usage
      return u ? { usage: { inputTokens: u.input ?? 0, outputTokens: u.output ?? 0 } } : {}
    })(),
    timestamp: m.timestamp ?? Date.now(),
  }

  // For user messages, parse <skill> blocks injected by pi backend.
  // content 统一为 Segment[]：有 skill 标签时拆出 skill segment + 后续 user text，
  // 无 skill 标签时用 textToSegments 包成纯 text segment。
  if (m.role === 'user' && textContent) {
    const parsed = parseSkillBlock(textContent)
    if (parsed) {
      msg.content = parsed
    } else {
      msg.content = textToSegments(textContent)
    }
  }
  return msg
}

/**
 * Convert pi message list into frontend Message[], merging toolResult
 * entries into their parent assistant message's matching toolCall.
 *
 * 签名收 unknown[]：pi 的历史结构（PiHistoryMessage/PiHistoryToolResult）是 pi 协议类型，
 * 只在此 infra 文件内部断言，不暴露给 service。service 传 RPC/文件读到的原始 JSON 即可。
 *
 * user/assistant 单条转换委托 convertSinglePiMessage（抽出供 entry-tree-builder 复用），
 * toolResult/compactionSummary/custom/branchSummary 等特殊 role 仍在此处内联处理
 * （这些类型不是 message entry 的 message 字段，不进 convertSinglePiMessage）。
 *
 * @param raw pi history message 列表（get_messages 返回 / JSONL 读取 / entry 树提取）
 * @param entryIds 可选，与 raw 一一对应的 entry id 列表（entry 树重建路径用）。
 *   传时 user/assistant message 会带上 piEntryId（按 index 取 entryIds[i]）。
 *   不传时行为不变（兼容 session-store.convertHistory / session-history 等 RPC/文件路径）。
 *   toolResult/系统消息分支不消费 entryId（它们或合并到上一个 assistant，或不需回填）。
 */
export function convertPiHistory(raw: unknown[], entryIds?: string[]): Message[] {
  const result: Message[] = []
  let lastAssistantWithToolCalls = -1

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const m = item as PiHistoryMessage | PiHistoryToolResult | { role: 'compactionSummary'; summary?: string; tokensBefore?: number; timestamp?: number } | { role: 'custom'; customType: string; content?: string; details?: Record<string, unknown>; timestamp?: number } | { role: 'branchSummary'; summary?: string; fromId?: string; timestamp?: number } | { role: 'bashExecution'; command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean; excludeFromContext?: boolean; timestamp: number }
    if (m.role === 'toolResult') {
      const toolResult = m as PiHistoryToolResult
      // Merge tool result into the last assistant message's matching toolCall
      if (lastAssistantWithToolCalls >= 0) {
        const lastAssistant = result[lastAssistantWithToolCalls]
        if (lastAssistant?.toolCalls) {
          const tc = lastAssistant.toolCalls.find(t => t.id === toolResult.toolCallId)
          if (tc) {
            // 对称恢复 outputRaw（规则 7.5：对话流状态必须可重开恢复）。
            // 实时路径（event-adapter handleToolExecutionEnd）已统一委托 normalizePiToolResult（W1），
            // 此处历史路径对称：直接传 toolResult（顶层有 content 数组，走归一函数的 content-array 分支），
            // output 存 stripAnsi 版本，outputRaw 存原始 ANSI 文本（仅当含 ANSI 时）。
            const { output, outputRaw } = normalizePiToolResult(toolResult)
            tc.output = output
            if (outputRaw) tc.outputRaw = outputRaw
            if (toolResult.isError) tc.status = 'error'
            // F1 修复：透传 details（含 __gui__），与实时路径（event-interpreter tool_call_end）对齐。
            // 规则 7.5：对话流状态必须可重开恢复——重开 session 后 __gui__ 不丢。
            // 来源是顶层 toolResult.details（历史路语义），与归一函数返回的 details（来自 raw 内，通常 undefined）不同——保留不变。
            if (toolResult.details && typeof toolResult.details === 'object' && !Array.isArray(toolResult.details)) {
              tc.details = toolResult.details
            }
          } else {
            console.warn('[message-converter] toolResult has no matching toolCall:', toolResult.toolCallId)
          }
        }
      } else {
        console.warn('[message-converter] toolResult with no preceding assistant message:', toolResult.toolCallId)
      }
      continue
    }

    // compactionSummary：pi 压缩记录（role !== user/assistant/toolResult，结构不同：无 content，有 summary/tokensBefore）。
    // 转成 system 消息 + compactionSummary 字段，前端 SystemNotice 渲染「上下文已压缩」。
    // AGENTS.md 规则 7.5：对话流状态必须可重开恢复——重开 session 时历史压缩记录经此分支还原。
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

    // custom message（pi CustomMessage，扩展经 sendMessage 注入的结构化通知）。
    // pi get_messages 返回 role:'custom'，带 customType/content/details。
    // 转成 system 消息（messageTurns 产出独立 RenderItem 穿插在 turn 间），
    // customType:"subagent-bg-notify" 时解析 details 为 BgNotifyDetails（单条或批量）。
    // AGENTS.md 规则 7.5：对话流状态必须可重开恢复——重开 session 时 background 完成通知经此分支还原。
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
      if (cm.customType === 'subagent-bg-notify' && cm.details) {
        const bgNotify = parseBgNotifyDetails(cm.details)
        if (bgNotify) msg.bgNotify = bgNotify
      }
      result.push(msg)
      continue
    }

    // branchSummary：pi 分支摘要记录（实时链路 event-adapter.ts:487 已处理）。
    // 历史路径（文件读取/RPC get_messages 返回 role:'branchSummary'）对称还原，
    // 否则重开 session 后分支摘要丢失（AGENTS.md 规则 7.5：可重开恢复）。
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

    // bashExecution：pi bash 执行记录（composer-bash-execute W1）。
    // pi get_messages 返回 role:'bashExecution'（与 message entry 平级的顶层 entry 类型），
    // 转成带 bashExecution 字段的 user 消息（前端渲染为 BashResult 气泡）。
    // exitCode undefined → null（与 dispatcher 广播 bashResult 时 `?? null` 对称，防 JSON 丢值）。
    // AGENTS.md 规则 7.5：对话流状态必须可重开恢复——重开 session 时 bash 执行记录经此分支还原。
    if (m.role === 'bashExecution') {
      const bm = m as { role: 'bashExecution'; command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean; excludeFromContext?: boolean; timestamp: number }
      result.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: '',
        status: 'complete',
        bashExecution: {
          command: bm.command,
          output: bm.output,
          exitCode: bm.exitCode ?? null,
          cancelled: bm.cancelled,
          truncated: bm.truncated,
          excludeFromContext: !!bm.excludeFromContext,
          timestamp: bm.timestamp,
        },
      } as Message)
      continue
    }

    // user or assistant → 委托 convertSinglePiMessage（未知 role 在 helper 内 warn + 返回 null 跳过）。
    // 抽出后行为不变：toolResult/compactionSummary/custom/branchSummary 上面已 continue，
    // 此处只剩 user/assistant/未知 role，与 helper 的判定一致。
    // entryIds 路径（entry 树重建）：按 index 取 entryId 传给 helper，填到 msg.piEntryId
    // （供 rebuildHistoryFromEntries 回查 clientUuidMap + segmentsMetadata 回填 badge）。
    // 不传 entryIds 时 entryId 为 undefined，helper 回退读 m.__entryId（文件路径注入），行为不变。
    const entryId = entryIds?.[i]
    const msg = convertSinglePiMessage(m as PiHistoryMessage, entryId !== undefined ? { entryId } : undefined)
    if (!msg) continue
    result.push(msg)
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lastAssistantWithToolCalls = result.length - 1
    }
  }

  return result
}
