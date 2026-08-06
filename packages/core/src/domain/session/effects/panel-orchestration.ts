/**
 * Panel orchestration —— panel 编排契约（IF3 / C-SS-3 落点）。
 *
 * 来源语义：packages/renderer/src/composables/features/useSideDrawer.ts 的 pendingOpenMap
 * + chat-message-effects.ts openTasksDrawerOnFirstData（FR-2 sid 守卫 + ADR-0053）。
 * 迁移约束：core 不 import renderer 任何 store（D4 零跨域 import），壳层经 PanelOrchestrationPort 注入实现。
 *
 * [ADR-0049 例外：明确判定，不再悬置] pendingOpen 是**临时路由标记**（非业务 per-session 状态）——
 * 存在即消费、随 consumePendingOpen 即删、不跨 session 存活。用模块级 Map<sid, panelId> 而非
 * useSessionScopedState。判据：本文件是纯函数模块（setPendingOpenForSid/openPanelOnSessionEvent/
 * consumePendingOpen/clearPendingOpen 均为独立导出函数，非 composable，无 Vue setup 上下文、无
 * sidRef: Ref<string|null>）；Map 存的是路由标记（'tasks'|'sideDrawer'，非 reactive 业务状态）。
 * useSessionScopedState 是 setup-scoped 工厂（要求 sidRef + reactive 容器契约），本模块无法
 * 满足——强套需把纯函数改造成 composable + 破坏所有调用方签名 + reactive 容器语义错位（路由
 * 标记不是响应式状态）。与 useChat/subscription-state 同属 ADR-0049「全局 sid 协调器例外类
 * （模块级 Map 合理）」。session 销毁清理：clearPendingOpen(sid) 由 use-session.ts
 * cleanupSessionState 编排调用（ES3：删 session 前清标记，防切回已删 session 误开 panel）。
 */
import type { PanelLeaf } from '@xyz-agent/shared'

/**
 * panel 编排端口（壳注入实现）。
 * 壳侧：focusedSessionId 读 usePanelStore().focusedSessionId、loadSession 调 panel.loadSession、
 * openPanel 调 useSideDrawer().open / tasks panel 打开逻辑。
 *
 * w3 追加（additive，w2 语义不变）：activePanelId / findPanelBySession——
 * use-session 的 syncSessionToPanel（loadSession 需 activePanelId）与
 * cleanupSessionState（panel 解绑前需按 session 查绑定 panel）编排需要。
 */
export interface PanelOrchestrationPort {
  /** 当前焦点 session（UI 高亮真相源；null = 无焦点） */
  focusedSessionId(): string | null
  /** 当前活跃 panel id（syncSessionToPanel 用；null = 无活跃 panel） */
  activePanelId(): string | null
  /** 按 session 查绑定 panel（cleanupSessionState 解绑用；null = 未绑定） */
  findPanelBySession(sid: string): PanelLeaf | null
  /** 让指定 panel 载入 session（syncSessionToPanel / selectSession 用） */
  loadSession(panelId: string, sessionId: string | null): void
  /** 打开 panel 并绑定 sid（tasks drawer / side drawer 统一入口） */
  openPanel(panelId: 'tasks' | 'sideDrawer', sid: string): void
}

/** DM1：pendingOpen 路由标记（模块级 Map，ADR-0049 例外——临时路由标记非业务 per-session 状态，详见文件头） */
const pendingOpenMap = new Map<string, 'tasks' | 'sideDrawer'>()

/** 置某 session 的 pendingOpen 标记（openPanelOnSessionEvent 非 focused 分支调） */
export function setPendingOpenForSid(sid: string, panelId: 'tasks' | 'sideDrawer'): void {
  pendingOpenMap.set(sid, panelId)
}

/** 查询某 session 的 pendingOpen 标记（测试 / 调试用） */
export function getPendingOpenForSid(sid: string): 'tasks' | 'sideDrawer' | null {
  return pendingOpenMap.get(sid) ?? null
}

/**
 * 事件驱动的 panel 打开编排（openTasksDrawerOnFirstData 语义迁移，panelId 泛化）。
 *
 * 三分支（顺序即优先级）：
 * 1. hadDataBefore=true → 直接 return：非首次数据不弹（调用方在写入前查 hasData 传入，
 *    对应现 openTasksDrawerOnFirstData 的『仅 hasData false→true 瞬间触发』语义）。
 * 2. port.focusedSessionId() === sid → port.openPanel 直调：事件归属即当前焦点，
 *    用户正看着该 session，直接弹（FR-2 命中分支）。
 * 3. 否则 setPendingOpenForSid(sid, panelId)：后台 session 事件不弹窗（ADR-0053），
 *    置标记待 selectSession 切回时经 consumePendingOpen 消费。
 *
 * 注意：本函数仅实时路径调（routeToolResult/routeToolStart），hydrate（重开 session）不调——
 * 用户主动切换 session 不应强制弹 panel，只有「新任务实时到达」才主动提示。
 */
export function openPanelOnSessionEvent(
  sid: string,
  panelId: 'tasks' | 'sideDrawer',
  hadDataBefore: boolean,
  port: PanelOrchestrationPort,
): void {
  if (hadDataBefore) return // 已有数据，非首次
  if (port.focusedSessionId() === sid) {
    port.openPanel(panelId, sid)
  } else {
    setPendingOpenForSid(sid, panelId)
  }
}

/**
 * 消费某 session 的 pendingOpen 标记：有标记则按存的 panelId openPanel + 清标记。
 * 挂在 w3 use-session.selectSession 内部（与现 useSidebar 的 consumePendingOpen 同位置）。
 * 幂等：无标记时 no-op；消费后标记即删，重复消费不再触发。
 */
export function consumePendingOpen(sid: string, port: PanelOrchestrationPort): void {
  const panelId = pendingOpenMap.get(sid)
  if (!panelId) return
  pendingOpenMap.delete(sid)
  // 切到该 session 时，focusedSessionId 已是该 sid，open 操作作用于当前分区
  port.openPanel(panelId, sid)
}

/**
 * 清某 session 的 pendingOpen 标记（ES3：session 删除前消费/清除，防切回已删 session 误开 panel）。
 * 幂等：无标记时 no-op。仅 domain 内部契约（w3 cleanupSessionState 编排用），不 re-export。
 */
export function clearPendingOpen(sid: string): void {
  pendingOpenMap.delete(sid)
}
