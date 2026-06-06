/**
 * useBatchSelect — 批量选择消息 composable
 *
 * 管理：batch mode 开关、selected IDs、批量复制。
 */
import { ref, watch } from 'vue'
import { collectMessageContent } from '../lib/collectMessageContent'
import { copyWithToast } from '../lib/clipboard'

const TIME_PAD_WIDTH = 2

export function useBatchSelect(
  sessionId: () => string | null | undefined,
  chatMsgsRef: () => HTMLElement | null,
) {
  const batchMode = ref(false)
  const selectedIds = ref<Set<string>>(new Set())

  // Reset batch mode when session changes (avoid stale state from previous session)
  watch(() => sessionId(), () => {
    batchMode.value = false
    selectedIds.value = new Set()
  })

  function toggleBatchMode() {
    batchMode.value = !batchMode.value
    if (!batchMode.value) {
      selectedIds.value = new Set()
    }
  }

  function exitBatchMode() {
    batchMode.value = false
    selectedIds.value = new Set()
  }

  function toggleSelect(entryId: string) {
    const next = new Set(selectedIds.value)
    if (next.has(entryId)) {
      next.delete(entryId)
    } else {
      next.add(entryId)
    }
    selectedIds.value = next
  }

  function collectBatchContent(elements: HTMLElement[], format: 'markdown' | 'plain'): string {
    const parts: string[] = []
    for (const el of elements) {
      const role = el.getAttribute('data-role') === 'user' ? '用户' : '助手'
      const ts = Number(el.getAttribute('data-timestamp') ?? '0')
      let timeLabel = ''
      if (ts > 0) {
        const d = new Date(ts)
        const hh = d.getHours().toString().padStart(TIME_PAD_WIDTH, '0')
        const mm = d.getMinutes().toString().padStart(TIME_PAD_WIDTH, '0')
        timeLabel = ` ${hh}:${mm}`
      }
      const content = collectMessageContent(el, { format })
      if (content) {
        parts.push(`--- ${role}${timeLabel} ---\n${content}`)
      }
    }
    return parts.join('\n\n')
  }

  async function copyBatchAs(format: 'markdown' | 'plain') {
    const ids = Array.from(selectedIds.value)
    if (ids.length === 0) return
    const elements: HTMLElement[] = []
    for (const id of ids) {
      const el = chatMsgsRef()?.querySelector(`[data-entry-id="${id}"]`) as HTMLElement | null
      if (el) elements.push(el)
    }
    if (elements.length === 0) {
      console.warn('[useBatchSelect] no message elements found for batch copy, ids:', ids)
      return
    }
    const text = collectBatchContent(elements, format)
    await copyWithToast(text, { format })
    exitBatchMode()
  }

  return {
    batchMode,
    selectedIds,
    toggleBatchMode,
    exitBatchMode,
    toggleSelect,
    copyBatchAs,
  }
}
