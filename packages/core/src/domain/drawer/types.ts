/**
 * drawer 域类型 —— @xyz-agent/core 平台无关内核（headless）的 drawer 域类型归位。
 *
 * 定位：p3-strangler-domains::drawer 的 W1 类型迁移，承接架构文档 §10.2
 * （旧层 → core/domain/* 映射：renderer composables/features/useSideDrawer.ts 的
 * SideDrawerTab / OpenDrawerOptions / DrawerControlState 迁移至此）。
 *
 * 迁移过渡期（旧 SideDrawer 未删）：renderer 侧 useSideDrawer.ts 改为 re-export 兼容层，
 * 本文件为 SSOT；旧调用方（SideDrawer.vue / useDrawerWidgetBuffers 等）经兼容层 import
 * 类型，零改动。
 *
 * 零 DOM 约束：core tsconfig 未配置 DOM lib，本文件为纯类型定义，不引入 DOM/浏览器 API 类型。
 */

/** SideDrawer 的 tab 枚举：terminal（终端）/ browser（浏览器）/ git（变更集）/ doc（命令文档）/ detail（文件详情）/ tasks（任务） */
export type SideDrawerTab = 'terminal' | 'browser' | 'git' | 'doc' | 'detail' | 'tasks'

/** drawer open 的可选参数：打开时指定要展示的 slash 命令名（Doc tab）/ 文件路径（Detail tab）/ URL（Browser tab） */
export interface OpenDrawerOptions {
  /** Doc tab 当前展示的命令名（如 '/commit'），CommandDocPanel 据此 + commandStore/skills 解析文档 */
  commandName?: string
  /** Detail tab 打开后立即展示的文件路径（变更集卡点击文件行时传入，强制 diff 模式） */
  filePath?: string
  /** Browser tab 打开后立即加载的 URL（点击 agent 输出的 http(s) 链接时传入） */
  url?: string
}

/** per-session 控制态（ADR-0053 Map 分区） */
export interface DrawerControlState {
  isOpen: boolean
  activeTab: SideDrawerTab
  docked: boolean
}
