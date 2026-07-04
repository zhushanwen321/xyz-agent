/**
 * 搜索模块共享类型（Tier 0）—— 跨 composable/store/component 共享的 DTO/值对象。
 *
 * 领域类型 SSOT 归位：SearchType / SearchItem 定义在此（D-028 架构修复）。
 * 历史遗留：v1 搜索全在 mock 目录，类型埋在 api/mock/search-data.ts，生产代码反向依赖 mock；
 * v2 编排重写时迁出到本文件，mock 反向 import 此处（方向：mock → 领域类型）。
 *
 * 复用的外部类型（import 复用，不重定义）：
 *  - FileNode：@xyz-agent/shared/file-tree
 *  - SessionSummary / SessionGroup：@xyz-agent/shared/session
 *  - SessionCommand：stores/command.ts
 *  - SideDrawerTab：composables/features/useSideDrawer（纯类型，JumpResult.drawerTab 用）
 */
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'

/** 搜索项类型（四类：命令/文件/符号/会话） */
export type SearchType = 'command' | 'file' | 'symbol' | 'session'

/** 搜索结果项（编排层 allSettled 聚合后的统一 DTO，mock + real 源都映射到此） */
export interface SearchItem {
  type: SearchType
  title: string
  sub: string
  /** slash 命令 icon key（star/terminal/wrench，与 CommandPopover SLASH_ICON_COMPONENTS 同源）。
   *  仅 slash 命令项携带（从 SessionCommand.icon 透传），应用命令/文件/符号/会话项无此字段。
   *  供 chip 注入时透传给 insertSlashChip(name, icon)，保证搜索注入的 chip 与 CommandPopover 选中的 chip 图标一致。 */
  icon?: string
  /** 命令细分类型（仅 type='command' 项携带）。
   *  'app' = 应用内置命令（走 commandStore.appCommands action 执行）；
   *  'slash' = pi 扩展命令（走 pendingSlash 注入 composer chip）。
   *  存在动机：pi get_commands 返回的命令名不带 / 前缀（如 'goal'/'skill:code-review'），
   *  无法靠 title.startsWith('/') 区分两类，故在 DTO 映射时显式标记，useSearchJump 据此精确分发。 */
  commandKind?: 'app' | 'slash'
}

/** 应用内置命令（#2，含 action 行为故非纯值对象） */
export interface AppCommand {
  id: string
  name: string
  shortcut?: string
  action: () => void
}

/**
 * recents 持久化项（#3 值对象）。
 * key 规则（AC-3.5）：type 冒号 title（title 稳定标识，sub 路径/branch 可变不入 key）。
 */
export interface RecentEntry {
  type: SearchType
  key: string
  timestamp: number // 计数器兜底 Math.max(stored)+1（AC-3.6），非裸 Date.now()
  title: string
  sub: string
}

/** 分组（domain/composable 输出整形，GAP-E1） */
export interface Section {
  label: string
  items: SearchItem[]
}

/** useSearch.query 的上下文（调用方注入） */
export interface SearchCtx {
  activeSessionId: string | null // null 时 file 源 + slash 源返空（AC-4.8）
}

/** useSearchJump.confirm 的上下文 */
export interface JumpCtx {
  activeSessionId: string | null // file 跳转需 cwd（AC-6.9 直调 fileApi.read）
}

/**
 * useSearchJump.confirm 的返回（AC-6.7 异常恢复：失败时浮层保持打开）。
 *
 * drawerTab：成功跳转后需打开的 SideDrawer tab（可选）。当前仅 file 跳转返 'detail'（文件
 * 预览需 DetailPane 挂载，由调用方 SearchModal 接线 useSideDrawer.open）。命令/会话跳转无
 * 此需求（命令触发自身 action，会话切换载入 panel），故缺省。编排层 useSearchJump 不依赖
 * useSideDrawer（架构约束：composable 层只返 JumpResult，不直接调 UI 状态）。
 */
export type JumpResult =
  | { ok: true; drawerTab?: SideDrawerTab }
  | { ok: false; error: string }

/** localStorage key（MR-3.2 骨架约束，对齐 xyz-agent: 冒号约定） */
export const RECENTS_STORAGE_KEY = 'xyz-agent:search-recents'

/** WS 源超时阈值（#17，对齐 runtime 量级） */
export const WS_SOURCE_TIMEOUT_MS = 10_000

/** recents 每类上限（D-007） */
export const RECENTS_PER_TYPE = 5
