import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { SessionSummary } from '@xyz-agent/shared'

/**
 * shadcn-vue 标准工具：合并 class 名，解决 Tailwind 类冲突。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── NewTaskFlow 派生纯函数（#4，code-architecture §3.4）──────────────────────────

/** recentWorkspaces 列表项（distinct cwd 单值快照）。label = 目录显示名（cwd basename）。 */
export interface RecentWorkspace {
  cwd: string
  lastActiveAt: number
  label: string
}

/**
 * 取目录显示名：cwd 末段（basename），长路径只显末段防溢出。
 * 与 Landing.vue 的 dirLabel、SessionItem.vue 的 dirName 同一语义，收敛到此避免三处重复。
 */
function cwdBasename(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

/**
 * 解析默认 cwd：最近活跃 session 的工作目录（单值，G1.1，AC-4.2/4.5）。
 *
 * 数据流：useNewTaskFlow.startFlow → resolveDefaultCwd(sessions) → cwd?
 * - 空列表 → undefined（首次启动，AC-1.7 延迟 create：不调 create，currentSessionId=null）
 * - cwd 为空串/undefined 的脏数据 → 跳过（AC-4.5，不归入 undefined 组污染列表）
 * - 多 session → 取 lastActiveAt 最大者的 cwd
 */
export function resolveDefaultCwd(sessions: SessionSummary[]): string | undefined {
  let best: SessionSummary | undefined
  for (const s of sessions) {
    if (!s.cwd) continue // 脏数据跳过（AC-4.5）
    if (!best || s.lastActiveAt > best.lastActiveAt) best = s
  }
  return best?.cwd
}

/**
 * 最近 workspace 列表：distinct cwd top10 按 lastActiveAt 倒序（AC-4.1/4.6）。
 *
 * 数据流：DirSelectPopover → recentWorkspaces(sessions) → RecentWorkspace[] top10。
 * - 空列表 → []（首次启动空态文案，E4）
 * - 多 session 同 cwd → 去重保留 lastActiveAt 最新者（AC-4.6）
 * - cwd 脏数据 → 跳过
 *
 * [HISTORICAL] label 字段语义曾误取 `s.label`（session 名）：session 未重命名时 label
 * 恰好 = basename(cwd)，故显示正常；用户重命名后 session 名变自定义文本，目录列表却把
 * 它当作目录名展示，与 Landing.vue 的 dirLabel（basename）口径不一致。修正为始终从 cwd
 * 派生 basename，使 RecentWorkspace.label 在语义上承载「目录显示名」而非 session 名。
 */
// LRU 上限：spec.md §6「最近 workspace 列表数据源」约定本地缓存最多 10 条
const MAX_RECENT_WORKSPACES = 10
export function recentWorkspaces(sessions: SessionSummary[]): RecentWorkspace[] {
  const byCwd = new Map<string, RecentWorkspace>()
  for (const s of sessions) {
    if (!s.cwd) continue // 脏数据跳过
    const existing = byCwd.get(s.cwd)
    // 同 cwd 保留最新（AC-4.6）
    if (!existing || s.lastActiveAt > existing.lastActiveAt) {
      byCwd.set(s.cwd, { cwd: s.cwd, lastActiveAt: s.lastActiveAt, label: cwdBasename(s.cwd) })
    }
  }
  return Array.from(byCwd.values())
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, MAX_RECENT_WORKSPACES)
}

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
