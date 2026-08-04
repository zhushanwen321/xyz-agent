/**
 * drawer 协同层 —— 模块级公开 API（C2 契约）+ pendingOpen 守卫 + 瞬时参数。
 *
 * 迁移自 renderer composables/features/useSideDrawer.ts 的协同部分（W1）：
 * - pendingOpenMap：事件驱动打开的 sid 守卫标记（后台 session 有「未展示给用户的 tasks
 *   到达事件」时置标记，selectSession 切回时 consumePendingOpen 消费）
 * - FR-9：用户手动 open（任意 tab）即清当前 session 的 pendingOpen（已注意，不再打扰）
 * - 瞬时参数（selectedCommandName/detailFilePath/browserUrl）：打开时的瞬时参数，
 *   消费后清空，不构成 session 级持久状态
 * - openTasksDrawerOnFirstData(sid, hasData)：tasks 数据守卫分发（core 零 tasks store
 *   依赖——hasData 由 renderer 调用方传入）
 *
 * 分层（C4）：单向依赖 control.ts（drawerControl 原语 + getBoundSessionId + getDrawerControlState）。
 * control 不 import 本文件（防循环）。pendingOpen 是协同状态，FR-9 清理放本层。
 *
 * 单 registry：registerSessionCleanup 来自 core foundation（renderer 的
 * composables/useSessionScopedState 是其 re-export shim），本文件注册的 cleanup
 * 与 useSessionScopedState 实例共享同一 registry，triggerSessionCleanups(sid) 统一触发。
 */
import { ref } from 'vue'
import { drawerControl, getBoundSessionId, getDrawerControlState, _resetDrawerControlForTest } from './control'
import { registerSessionCleanup } from '../../foundation/use-session-scoped-state'
import type { SideDrawerTab, OpenDrawerOptions } from './types'

// ── pendingOpen：事件驱动打开的 sid 守卫标记（独立 Map，不复用 per-session isOpen）──
// 语义：某 session 有「未展示给用户的 tasks 到达事件」。sid !== focusedSessionId 时事件
// 不直接 open，只置此标记；selectSession 切回时 consumePendingOpen 消费（open tasks + 清标记）。
// 用户手动 open（任意 tab）即清当前 session 标记（FR-9：已注意，不再打扰）。
const pendingOpenMap = new Map<string, boolean>()

/** 置某 session 的 pendingOpen 标记（openTasksDrawerOnFirstData 调，sid 守卫不通过时） */
export function setPendingOpenForSid(sid: string): void {
  pendingOpenMap.set(sid, true)
}

/** 查询某 session 的 pendingOpen 标记（测试 / 调试用） */
export function getPendingOpenForSid(sid: string): boolean {
  return pendingOpenMap.get(sid) ?? false
}

/** 清某 session 的 pendingOpen 标记 */
function clearPendingOpenForSid(sid: string): void {
  pendingOpenMap.delete(sid)
}

// ── 不分区的瞬时参数（模块级单例，消费后清空）──
// 供 renderer 兼容层 re-export（useSideDrawer() 返回形状含这三个 ref + consumeBrowserUrl）。
/** Doc tab 当前展示的命令名（点击用户气泡 slash chip 时设置） */
export const selectedCommandName = ref<string | null>(null)
/**
 * Detail tab 打开时立即展示的文件路径（点击即看 diff）。
 * 由变更集卡等非文件树入口设置；useDetailPane watch 它并强制 diff 模式。
 * 用完即清空（消费后置 null），避免残留导致下次打开 detail tab 被旧值劫持。
 */
export const detailFilePath = ref<string | null>(null)
/**
 * Browser tab 打开时立即加载的 URL（点击 agent 输出的链接设置）。
 * 由 useMarkdownInteractions 外链分支设置；SideDrawer/BrowserPane 据此触发导航。
 * 用完即清空（消费后置 null），避免残留导致下次打开 browser tab 被旧值劫持。
 */
export const browserUrl = ref<string | null>(null)

/** 消费 browserUrl：读取并清空（BrowserPane 挂载时调，取到非空值触发导航） */
export function consumeBrowserUrl(): string | null {
  const url = browserUrl.value
  browserUrl.value = null
  return url
}

// ── 模块级公开 API（C2）──

/**
 * 打开抽屉，可指定初始 tab + Doc tab 的选中命令 / Detail tab 的文件路径 / Browser tab 的 URL。
 * FR-9：手动 open（任意 tab）即清当前 session 的 pendingOpen（用户已注意，不再打扰）。
 * 瞬时参数写入对应 ref（消费后清空）。
 */
export function openDrawerTab(tab?: SideDrawerTab, opts?: OpenDrawerOptions): void {
  const sid = getBoundSessionId()
  if (sid) clearPendingOpenForSid(sid)
  if (opts?.commandName !== undefined) selectedCommandName.value = opts.commandName
  if (opts?.filePath !== undefined) detailFilePath.value = opts.filePath
  if (opts?.url !== undefined) browserUrl.value = opts.url
  drawerControl.open(tab)
}

/** 关闭抽屉（钉住态亦可手动关闭） */
export function closeDrawer(): void {
  drawerControl.close()
}

/** 切换开关；从关到开可指定 tab */
export function toggleDrawer(tab?: SideDrawerTab): void {
  if (getDrawerControlState().isOpen) closeDrawer()
  else openDrawerTab(tab)
}

/** 切换 tab（抽屉关闭时仅改 activeTab，不自动打开）。tasks tab 自动 docked（仅当前分区） */
export function setDrawerTab(tab: SideDrawerTab): void {
  drawerControl.setTab(tab)
}

/** 切换钉住态（仅当前分区） */
export function toggleDrawerDock(): void {
  drawerControl.toggleDock()
}

/**
 * 消费某 session 的 pendingOpen：为 true 则 open('tasks') 并清标记。
 * 挂在 useSidebar.selectSession 内部（与 commands/context 兜底拉取同位置），
 * 不挂独立 watch(focusedSessionId)——避免撞 Runtime broadcast 时序竞争。
 */
export function consumePendingOpen(sid: string): void {
  if (!pendingOpenMap.get(sid)) return
  clearPendingOpenForSid(sid)
  // 切到该 session 时，focusedSessionId 已是该 sid，open 操作作用于当前分区
  openDrawerTab('tasks')
}

/**
 * tasks 首数据到达守卫分发（core 零 tasks store 依赖——hasData 由 renderer 调用方传入）。
 * - hasData=false 直接 return（调用方前置守卫，不 open 不置标记）
 * - hasData=true 时：绑定 sid === 入参 sid ? openDrawerTab('tasks') : setPendingOpenForSid(sid)
 */
export function openTasksDrawerOnFirstData(sid: string, hasData: boolean): void {
  if (!hasData) return
  if (getBoundSessionId() === sid) {
    openDrawerTab('tasks')
  } else {
    setPendingOpenForSid(sid)
  }
}

// session 销毁时清理 pendingOpen（controlState 分区由 useSessionScopedState 自动注册）
registerSessionCleanup((sid) => {
  pendingOpenMap.delete(sid)
})

/**
 * 重置 drawer 全部状态（测试隔离用）：control 分区 + pendingOpenMap + 瞬时参数。
 * 生产代码禁止调用。renderer 兼容层 resetSideDrawer() 委托本函数。
 */
export function _resetDrawerForTest(): void {
  _resetDrawerControlForTest()
  pendingOpenMap.clear()
  selectedCommandName.value = null
  detailFilePath.value = null
  browserUrl.value = null
}
