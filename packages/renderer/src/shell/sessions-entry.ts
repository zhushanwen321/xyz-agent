/**
 * sessions-entry —— 新壳 sidebar/session 挂载点签名（D5 占位，C-W5-3）。
 *
 * P3 逐域绞杀期间（§11.2），UI 入口先以「壳内硬编码占位」形态存在——壳直接渲染该域原生
 * 组件，不走 contribution 路由。待 P4 ExtensionHost 落地后再把占位统一替换为 contribution 驱动。
 *
 * 本文件只声明挂载点签名（SessionsShellMountPoint 接口，对齐 useSidebarNew 返回签名的
 * 挂载点消费子集）+ 占位标识常量（SESSIONS_SHELL_MOUNT_POINT），不实现 register/mount，
 * 不 import contribution registry / extension-host——是 P4 contribution 路由升级时的契约锚点。
 *
 * 与 shell/index.ts（RENDERER_SHELL_SCAFFOLD）并列。
 */
import type { ComputedRef } from 'vue'
import type { BatchDeleteResult, SessionSummary } from '@xyz-agent/shared'

/**
 * 新壳 sidebar/session 挂载点消费的句柄形状。
 *
 * 对齐 useSidebarNew 返回签名（packages/renderer/src/composables/features/useSidebarNew.ts）
 * 的挂载点消费子集——P4 contribution 路由升级时，ExtensionHost 经此契约拿到 sidebar/session
 * 入口所需的 session 管理能力。D5 占位期壳直接消费 useSidebarNew 实例（不经本接口），本接口
 * 是 P4 切换「换实现（contribution 注入）不改契约」的前置声明。
 */
export interface SessionsShellMountPoint {
  /** 当前焦点 panel 绑定的 session（UI 高亮 SSOT；null = 无焦点） */
  focusedSessionId: ComputedRef<string | null>
  /** 焦点 session 的 summary（label/branch 用）；找不到则 null */
  focusedSession: ComputedRef<SessionSummary | null>
  /** 选择 session（全编排：switch + hydrate + panel 载入 + streaming 订阅） */
  selectSession(id: string): Promise<void>
  /** 新建 session（延迟 create 语义；返回新 id 或 null） */
  newSession(presetCwd?: string): Promise<string | null>
  /** 加载 session 列表（按 cwd 分组） */
  loadSessions(): Promise<void>
  /** 重命名 session（API + 乐观更新） */
  renameSession(id: string, label: string): Promise<void>
  /** 删除单个 session（API + 跨 store 清理 + wasActive 回退） */
  deleteSession(id: string): Promise<void>
  /** 按 cwd 批量删除（返回 deleted/failed 供 caller toast） */
  deleteFolder(cwd: string): Promise<BatchDeleteResult>
  /** 重试加载历史（landing 重试出口） */
  retryHistory(sessionId: string): Promise<void>
}

/**
 * 新壳 sidebar/session 挂载点占位标识（D5 placeholder）。
 *
 * P4 ExtensionHost 落地后，此常量替换为 contribution 注册标识（MountPointRegistry 注册
 * 'sessions' 挂载点 + contribution 路由消费 SessionsShellMountPoint）。P3 期间壳直接
 * 消费 useSidebarNew，不经此常量做路由——它仅作 P4 升级的契约锚点存在。
 */
// D5 placeholder: P4 ExtensionHost 落地后替换为 contribution 注册
export const SESSIONS_SHELL_MOUNT_POINT = 'sessions' as const
