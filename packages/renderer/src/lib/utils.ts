import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Segment } from '@xyz-agent/shared'

/**
 * shadcn-vue 标准工具：合并 class 名，解决 Tailwind 类冲突。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 编辑 user message 后重建 segments：保持原 segment 顺序，用 editedText 替换首个 text 段内容，
 * 其余段（image/skill/file/mention）原位保留。
 *
 * - 原 message 有 text 段：首个 text 段位置替换为 editedText，多余 text 段丢弃（合并到首个）
 * - 原 message 无 text 段但 editedText 非空：editedText 插到最前
 * - editedText 为空：移除所有 text 段（用户清空编辑框）
 *
 * 抽出 Turn.vue 以满足 <script setup> ≤300 行约束。M2 修复：不再写死 [text, ...images]
 * 顺序，避免 [图片, text] 等混合顺序被重排（scramble [图片 N] 编号 + prompt 文本顺序）。
 */
export function rebuildSegmentsWithEditedText(
  originalSegments: Segment[] | string,
  editedText: string,
): Segment[] {
  const source = Array.isArray(originalSegments) ? originalSegments : []
  const segments: Segment[] = []
  let textPlaced = false
  for (const seg of source) {
    if (seg.type === 'text') {
      if (editedText && !textPlaced) {
        segments.push({ type: 'text', text: editedText })
        textPlaced = true
      }
      // editedText 为空或已放置首个 text 段 → 丢弃后续 text 段
    } else {
      // image/skill/file/mention 段原位保留
      segments.push(seg)
    }
  }
  if (!textPlaced && editedText) {
    segments.unshift({ type: 'text', text: editedText })
  }
  return segments
}

