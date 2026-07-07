/**
 * useAppCommands —— 应用内置命令注册（#2 D-004 命令注册表的应用命令区填充）。
 *
 * 职责：构建应用级命令列表（新建/收起侧栏/概览），注册到 commandStore.appCommands，
 * 供 useCommandRegistry 聚合进搜索命令源 + useSearchJump.confirmCommand 按 name 查找执行 action。
 *
 * 接线层级：stores/command（registerApp）+ stores/sidebar（toggleCollapsed）。
 * actions 由调用方（useSidebar.initApp）注入，避免与 useSidebar 循环 import
 * （useSidebar.initApp 调本函数，本函数若再 import useSidebar 会成环）。
 *
 * 设计约束（spec G1.1 / D-004 / D-009）：
 *  - ⌘K（搜索本身）**不注册**为 appCommand：否则搜索结果出现「搜索」命令，逻辑自指（唤起搜索的命令
 *    出现在搜索结果里）。⌘K 的快捷键由 Sidebar keymap 兜底。
 *  - 命令按 name 唯一标识，pi slash 命令带 / 前缀（/commit）天然不与应用命令撞名（D-009）。
 *
 * 依赖方向：stores/command（registerApp）+ stores/sidebar（toggleCollapsed）。
 * 不依赖 api，不依赖 useCommandRegistry（registerApp 在 store 层，无需 session 上下文），不依赖 useSidebar（actions 注入破环）。
 */
import type { AppCommand } from '@/lib/search-types'
import { useCommandStore } from '@/stores/command'
import { useSidebarStore } from '@/stores/sidebar'

/** 应用命令依赖的 actions（由调用方注入，打破与 useSidebar 的循环 import） */
export interface AppCommandActions {
  /** 新建任务（useSidebar.newSession） */
  newSession: () => void
  /** 进入概览（useSidebar.goOverview） */
  goOverview: () => void
}

/**
 * 构建并注册应用内置命令。
 * @param actions newSession/goOverview（调用方 useSidebar.initApp 注入）
 */
export function registerAppCommands(actions: AppCommandActions): void {
  const sidebarStore = useSidebarStore()

  const appCommands: AppCommand[] = [
    { id: 'new-session', name: '新建任务', shortcut: '⌘N', action: actions.newSession },
    { id: 'toggle-sidebar', name: '收起侧栏', shortcut: '⌘B', action: () => sidebarStore.toggleCollapsed() },
    { id: 'go-overview', name: '概览', action: actions.goOverview },
  ]

  // 直接写 commandStore.appCommands（registerApp 在 store 层，与 session 无关）。
  // 不经 useCommandRegistry（其构造需 activeSessionId 参数，而注册应用命令不需要 session 上下文）。
  const commandStore = useCommandStore()
  commandStore.registerApp(appCommands)
}
