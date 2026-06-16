/**
 * copyWithToast — copy text to clipboard with Toast feedback via toast store
 *
 * Shows a success/danger toast. Falls back gracefully if clipboard API is unavailable.
 */

import { useToastStore } from '../stores/toast'

/**
 * Copy text to system clipboard and show Toast feedback.
 *
 * @param text - Text to copy
 * @param opts.format - 'markdown' | 'plain' (currently informational only)
 */
export async function copyWithToast(
  text: string,
  opts?: { format?: 'markdown' | 'plain' },
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    useToastStore().show({
      type: 'success',
      title: opts?.format === 'plain' ? '已复制（纯文本）' : '已复制',
    })
  } catch (e) {
    // Preserve original error for diagnostics; users see a Toast, devs see the stack.
    console.error('[clipboard] writeText failed:', e)
    useToastStore().show({
      type: 'danger',
      title: '复制失败',
      description: e instanceof Error ? e.message : '无法访问剪贴板',
    })
  }
}
