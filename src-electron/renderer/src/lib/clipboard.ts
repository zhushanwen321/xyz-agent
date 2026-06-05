/**
 * copyWithToast — copy text to clipboard with Toast feedback via event-bus
 *
 * Emits 'toast:show' event with success/feedback data.
 * Falls back gracefully if clipboard API is unavailable.
 */

import { emit } from './event-bus'

export interface CopyToastPayload {
  type: 'success' | 'danger'
  title: string
  description?: string
}

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
    emit('toast:show', {
      type: 'success',
      title: opts?.format === 'plain' ? '已复制（纯文本）' : '已复制',
    } satisfies CopyToastPayload)
  } catch (e) {
    // Preserve original error for diagnostics; users see a Toast, devs see the stack.
    console.error('[clipboard] writeText failed:', e)
    emit('toast:show', {
      type: 'danger',
      title: '复制失败',
      description: e instanceof Error ? e.message : '无法访问剪贴板',
    } satisfies CopyToastPayload)
  }
}
