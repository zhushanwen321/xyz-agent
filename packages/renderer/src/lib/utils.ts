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

// ── session label 派生函数（W3 后保留：recentWorkspaces/resolveDefaultCwd 已迁移至 workspaceStore）──

/** session label 截断阈值：取首条提示词前 N 字符（codePoint 计，中文/emoji 算 1 字） */
const SESSION_LABEL_MAX = 10
/** 空提示词兜底文案（UI 已拦截空提交，此处为防御性默认，见 deriveSessionLabel） */
const EMPTY_PROMPT_FALLBACK = '无提示词'

/**
 * 从首条提示词派生 session label（codePoint 计前 10 字符，超长加省略号）。
 *
 * 规则：
 * - 空白（含纯换行/空格）→ 兜底文案『无提示词』（新建页面 composer 拦截空提交，此为兜底）
 * - ≤10 字符 → 原文
 * - >10 字符 → 前 10 字符 + '…'
 *
 * 用 Array.from 按 codePoint 拆分：中文/emoji 算 1 字，避免 UTF-16 代理对被截断成乱码。
 */
export function deriveSessionLabel(text: string): string {
  const chars = Array.from(text.trim())
  if (chars.length === 0) return EMPTY_PROMPT_FALLBACK
  if (chars.length <= SESSION_LABEL_MAX) return chars.join('')
  return chars.slice(0, SESSION_LABEL_MAX).join('') + '…'
}
