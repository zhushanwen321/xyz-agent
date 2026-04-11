import { ref, computed } from 'vue'
import type { ChatMessage, AssistantSegment } from '../types'

/** 将 assistant 的结构化片段序列化为 Markdown */
function formatSegments(segments: AssistantSegment[]): string {
  return segments
    .map(seg => {
      if (seg.type === 'text') return seg.text
      if (seg.type === 'tool') {
        const c = seg.call
        let s = `**Tool: ${c.tool_name}**\n\`\`\`json\n${JSON.stringify(c.input, null, 2)}\n\`\`\``
        if (c.output) {
          s += `\n**Result:**\n\`\`\`\n${c.output}\n\`\`\``
        }
        return s
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

/** 将消息列表格式化为 LLM 友好的 Markdown 文本 */
function formatMessagesForLLM(messages: ChatMessage[]): string {
  return messages
    .map(msg => {
      const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System'
      const content = msg.segments?.length ? formatSegments(msg.segments) : msg.content
      if (!content.trim()) return null
      return `**${role}**:\n${content}`
    })
    .filter((m): m is string => m !== null)
    .join('\n\n---\n\n')
}

export function useConversationCopy() {
  const selectMode = ref(false)
  const selectedIds = ref<Set<string>>(new Set())
  const copied = ref(false)

  const selectedCount = computed(() => selectedIds.value.size)

  function toggleSelectMode() {
    selectMode.value = !selectMode.value
    selectedIds.value = new Set()
    copied.value = false
  }

  function toggleMessage(id: string) {
    const next = new Set(selectedIds.value)
    next.has(id) ? next.delete(id) : next.add(id)
    selectedIds.value = next
  }

  function selectAll(messages: ChatMessage[]) {
    selectedIds.value = new Set(messages.map(m => m.id))
  }

  async function copySelected(messages: ChatMessage[]): Promise<boolean> {
    const selected = messages.filter(m => selectedIds.value.has(m.id))
    if (!selected.length) return false
    const ok = await writeToClipboard(formatMessagesForLLM(selected))
    if (ok) flashCopied()
    return ok
  }

  async function copyAll(messages: ChatMessage[]): Promise<boolean> {
    if (!messages.length) return false
    const ok = await writeToClipboard(formatMessagesForLLM(messages))
    if (ok) flashCopied()
    return ok
  }

  async function writeToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  function flashCopied() {
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  }

  return {
    selectMode, selectedIds, selectedCount, copied,
    toggleSelectMode, toggleMessage, selectAll,
    copySelected, copyAll,
  }
}
