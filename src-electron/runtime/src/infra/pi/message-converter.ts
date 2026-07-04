import type {
  PiHistoryMessage,
  PiHistoryToolResult,
} from './pi-protocol.js'
import type { Message, ThinkingBlock, ToolCall, FileChange } from '@xyz-agent/shared'

/**
 * Parse `<skill name="xxx" location="...">...</skill>` blocks from
 * a user message's text content. Returns the extracted skill name and the
 * remaining user text (everything after the closing `</skill>` tag).
 * Returns `null` if no skill block is found.
 */
function parseSkillBlock(text: string): { skillName: string; skillLocation?: string; userText: string } | null {
  const match = text.match(/<skill\s+name="([^"]+)"(?:\s+location="([^"]+)")?[^>]*>[\s\S]*?<\/skill>([\s\S]*)$/)
  if (!match) return null
  return {
    skillName: match[1],
    skillLocation: match[2] || undefined,
    userText: match[3].trim(),
  }
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
 * Convert pi message list into frontend Message[], merging toolResult
 * entries into their parent assistant message's matching toolCall.
 *
 * 签名收 unknown[]：pi 的历史结构（PiHistoryMessage/PiHistoryToolResult）是 pi 协议类型，
 * 只在此 infra 文件内部断言，不暴露给 service。service 传 RPC/文件读到的原始 JSON 即可。
 */
export function convertPiHistory(raw: unknown[]): Message[] {
  const result: Message[] = []
  let lastAssistantWithToolCalls = -1

  for (const item of raw) {
    const m = item as PiHistoryMessage | PiHistoryToolResult
    if (m.role === 'toolResult') {
      const toolResult = m as PiHistoryToolResult
      // Merge tool result into the last assistant message's matching toolCall
      if (lastAssistantWithToolCalls >= 0) {
        const lastAssistant = result[lastAssistantWithToolCalls]
        if (lastAssistant?.toolCalls) {
          const tc = lastAssistant.toolCalls.find(t => t.id === toolResult.toolCallId)
          if (tc) {
            const textParts = (Array.isArray(toolResult.content) ? toolResult.content : [])
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map(p => p.text ?? '')
              .join('\n')
            tc.output = textParts
            if (toolResult.isError) tc.status = 'error'
          } else {
            console.warn('[message-converter] toolResult has no matching toolCall:', toolResult.toolCallId)
          }
        }
      } else {
        console.warn('[message-converter] toolResult with no preceding assistant message:', toolResult.toolCallId)
      }
      continue
    }

    // user or assistant
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

    const msg: Message = {
      id: crypto.randomUUID(),
      role: m.role === 'user' ? 'user' : 'assistant',
      content: textContent,
      status: 'complete',
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
    // Strips the entire skill document from content, sets skillName,
    // and leaves only the user's actual text.
    if (m.role === 'user' && textContent) {
      const parsed = parseSkillBlock(textContent)
      if (parsed) {
        msg.skillName = parsed.skillName
        if (parsed.skillLocation) msg.skillLocation = parsed.skillLocation
        msg.content = parsed.userText
      }
    }
    result.push(msg)
    if (toolCalls.length > 0) {
      lastAssistantWithToolCalls = result.length - 1
    }
  }

  return result
}
