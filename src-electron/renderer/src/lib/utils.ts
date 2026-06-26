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

/** recentWorkspaces 列表项（distinct cwd 单值快照） */
export interface RecentWorkspace {
  cwd: string
  lastActiveAt: number
  label: string
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
      byCwd.set(s.cwd, { cwd: s.cwd, lastActiveAt: s.lastActiveAt, label: s.label })
    }
  }
  return Array.from(byCwd.values())
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, MAX_RECENT_WORKSPACES)
}
