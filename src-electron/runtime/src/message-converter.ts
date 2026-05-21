import type {
  PiHistoryMessage,
  PiHistoryToolResult,
} from './pi-rpc-types.js'
import type { Message, ThinkingBlock, ToolCall } from '@xyz-agent/shared'

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
          }
        }
      }
      continue
    }

    // user or assistant
    const parts = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text' as const, text: String(m.content) }]
    let textContent = ''
    const thinking: ThinkingBlock[] = []
    const toolCalls: ToolCall[] = []

    for (const part of parts) {
      if (part.type === 'text') {
        textContent += part.text ?? ''
      } else if (part.type === 'thinking') {
        thinking.push({
          id: crypto.randomUUID(),
          content: part.thinking ?? '',
          collapsed: true,
        })
      } else if (part.type === 'toolCall' || part.type === 'tool_use') {
        toolCalls.push({
          id: part.id ?? crypto.randomUUID(),
          toolName: part.name ?? '',
          input: part.arguments ?? {},
          status: 'completed',
          startTime: m.timestamp ?? Date.now(),
        })
      }
    }

    const msg: Message = {
      id: crypto.randomUUID(),
      role: m.role === 'user' ? 'user' : 'assistant',
      content: textContent,
      status: 'complete',
      ...(thinking.length > 0 && { thinking }),
      ...(toolCalls.length > 0 && { toolCalls }),
      timestamp: m.timestamp ?? Date.now(),
    }
    result.push(msg)
    if (toolCalls.length > 0) {
      lastAssistantWithToolCalls = result.length - 1
    }
  }

  return result
}
