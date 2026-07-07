import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn-vue 标准工具：合并 class 名，解决 Tailwind 类冲突。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
