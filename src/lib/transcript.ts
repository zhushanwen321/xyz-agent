import type { ChatMessage, AssistantSegment, TranscriptEntry, UserContentBlock, AssistantContentBlock } from '../types'

/** 将 TranscriptEntry[] 转为前端 ChatMessage[]（含 tool output 关联） */
export function transcriptToMessages(entries: TranscriptEntry[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  const toolOutputs = new Map<string, { output: string; is_error: boolean }>()

  for (const entry of entries) {
    if (entry.type === 'user') {
      for (const block of (entry.content as UserContentBlock[])) {
        if (block.type === 'tool_result') {
          toolOutputs.set(block.tool_use_id, { output: block.content, is_error: block.is_error })
        }
      }
    }
  }

  for (const entry of entries) {
    if (entry.type === 'user') {
      const blocks = entry.content as UserContentBlock[]
      const hasText = blocks.some(b => b.type === 'text')
      if (!hasText) continue
      const text = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text).join('')
      msgs.push({ id: entry.uuid, role: 'user', content: text, timestamp: entry.timestamp })
    } else if (entry.type === 'assistant') {
      const blocks = entry.content as AssistantContentBlock[]
      const segments: AssistantSegment[] = blocks.map(b => {
        if (b.type === 'text') return { type: 'text' as const, text: b.text }
        const result = toolOutputs.get(b.id)
        return {
          type: 'tool' as const,
          call: {
            tool_use_id: b.id,
            tool_name: b.name,
            input: b.input,
            status: result ? (result.is_error ? 'error' as const : 'completed' as const) : 'completed' as const,
            output: result?.output,
          },
        }
      })
      msgs.push({ id: entry.uuid, role: 'assistant', content: '', segments, timestamp: entry.timestamp })
    }
  }

  return msgs
}
