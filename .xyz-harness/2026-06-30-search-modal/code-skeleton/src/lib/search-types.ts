/**
 * 搜索模块共享类型（Tier 0）—— 跨 composable/store/component 共享的 DTO/值对象。
 *
 * 现有类型（import 复用，不重定义）：
 *  - SearchItem / SearchType：api/mock/search-data.ts（SearchItem 形态 SSOT）
 *  - FileNode：@xyz-agent/shared/file-tree
 *  - SessionSummary / SessionGroup：@xyz-agent/shared/session
 *  - SessionCommand：stores/command.ts
 *
 * 本文件只定义新增类型（AppCommand / RecentEntry / Section / SearchCtx / JumpCtx / JumpResult）。
 */
import type { SearchItem } from '@/api/mock/search-data'

/** re-export（useRecents 等需按 type 分组） */
export type { SearchType } from '@/api/mock/search-data'
import type { SearchType } from '@/api/mock/search-data'

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

/** useSearchJump.confirm 的返回（AC-6.7 异常恢复：失败时浮层保持打开） */
export type JumpResult = { ok: true } | { ok: false; error: string }

/** localStorage key（MR-3.2 骨架约束，对齐 xyz-agent: 冒号约定） */
export const RECENTS_STORAGE_KEY = 'xyz-agent:search-recents'

/** WS 源超时阈值（#17，对齐 runtime 量级） */
export const WS_SOURCE_TIMEOUT_MS = 10_000

/** recents 每类上限（D-007） */
export const RECENTS_PER_TYPE = 5
