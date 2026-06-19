import type {
  PiHistoryMessage,
  PiHistoryToolResult,
} from './pi-protocol.js'
import type { Message, ThinkingBlock, ToolCall } from '@xyz-agent/shared'

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
 * Convert pi message list into frontend Message[], merging toolResult
 * entries into their parent assistant message's matching toolCall.
 */
export function convertPiHistory(raw: (PiHistoryMessage | PiHistoryToolResult)[]): Message[] {
  const result: Message[] = []
  let lastAssistantWithToolCalls = -1

  for (const m of raw) {
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

    // Add text block once after loop (if any text was accumulated)
    if (textContent) {
      contentBlocks.unshift({ type: 'text', refId: 'text' })
    }

    const msg: Message = {
      id: crypto.randomUUID(),
      role: m.role === 'user' ? 'user' : 'assistant',
      content: textContent,
      status: 'complete',
      ...(thinking.length > 0 && { thinking }),
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(contentBlocks.length > 0 && { contentBlocks }),
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
