/**
 * lib/utils —— NewTaskFlow 派生纯函数（#4，§3.4）。
 *
 * 骨架镜像：真实 src-electron/renderer/src/lib/utils.ts 另含 cn()（clsx+tailwind-merge），
 * 与 NewTaskFlow 正交且依赖 clsx（仅在 src-electron/node_modules），故骨架省略 cn()，
 * 仅放本期新增 2 个纯函数（零外部依赖，纯计算）。
 *
 * 依赖方向：仅依赖 @xyz-agent/shared 的 SessionSummary 类型（纯函数零内部依赖，§2 import 规则）。
 */
import type { SessionSummary } from '@xyz-agent/shared'

/** recentWorkspaces 列表项（§3.4，distinct cwd 单值快照） */
export interface RecentWorkspace {
  cwd: string
  lastActiveAt: number
  label: string
}

/**
 * 解析默认 cwd：最近活跃 session 的工作目录（单值，#4 AC-4.2/4.5）。
 *
 * 数据流：useNewTaskFlow.startFlow → resolveDefaultCwd(sessions) → cwd?
 * - 空列表 → undefined（首次启动，AC-1.7 延迟 create：不调 create，currentSessionId=null）
 * - cwd 为 null/undefined 的脏数据 → 跳过（AC-4.5）
 * - 多 session → 取 lastActiveAt 最大者的 cwd
 *
 * [leaf] 纯计算，签名即设计，无隐藏复杂度。
 */
export function resolveDefaultCwd(sessions: SessionSummary[]): string | undefined {
  if (sessions.length === 0) return undefined
  let best: SessionSummary | undefined
  for (const s of sessions) {
    if (!s.cwd) continue // 脏数据跳过（AC-4.5）
    if (!best || s.lastActiveAt > best.lastActiveAt) best = s
  }
  return best?.cwd
}

/**
 * 最近 workspace 列表：distinct cwd top10 按 lastActiveAt 倒序（#4 AC-4.1/4.6）。
 *
 * 数据流：DirSelectPopover → recentWorkspaces(sessions) → RecentWorkspace[] top10。
 * - 空列表 → []（首次启动空态文案，E4）
 * - 多 session 同 cwd → 去重保留最新（AC-4.6）
 *
 * [leaf] 纯计算。
 */
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
    .slice(0, 10)
}
