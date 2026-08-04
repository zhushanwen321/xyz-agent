/**
 * rebuildSegmentsWithEditedText —— 编辑 user message 后重建 segments（w6 从 renderer lib/utils.ts 迁入）。
 *
 * 把原始 segments（text/skill/file/image/mention）里的首个 text 段替换为编辑后的文本，
 * 其余段原位保留（image/skill/file 等不被编辑影响）。
 *
 * 纯函数，仅依赖 @xyz-agent/shared Segment 类型。
 */
import type { Segment } from '@xyz-agent/shared'

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
    } else {
      segments.push(seg)
    }
  }
  if (!textPlaced && editedText) {
    segments.unshift({ type: 'text', text: editedText })
  }
  return segments
}
