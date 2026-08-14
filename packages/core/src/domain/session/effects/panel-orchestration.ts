/**
 * Panel orchestration —— panel 编排契约（IF3 / C-SS-3 落点）。
 *
 * [P4 s5 drawer-widget-removal] pendingOpen 路由机制（pendingOpenMap/setPendingOpenForSid/
 * getPendingOpenForSid/openPanelOnSessionEvent/consumePendingOpen/clearPendingOpen）已整套删除：
 * 旧 widget/tasks 通道由 PluginViewContainer 承接，无消费方。本文件仅保留 PanelOrchestrationPort
 * 端口接口（use-session.ts 的 panel 编排依赖：focusedSessionId/activePanelId/findPanelBySession/
 * loadSession/openPanel），壳层经此注入实现。
 *
 * 迁移约束：core 不 import renderer 任何 store（D4 零跨域 import），壳层经 PanelOrchestrationPort 注入实现。
 */
import type { PanelLeaf } from '@xyz-agent/shared'

/**
 * panel 编排端口（壳注入实现）。
 * 壳侧：focusedSessionId 读 usePanelStore().focusedSessionId、loadSession 调 panel.loadSession、
 * openPanel 调 useSideDrawer().open。
 *
 * [P4 s5 drawer-widget-removal] openPanel 参数收窄：panelId 唯一合法值 'sideDrawer'（tasks 面板
 * 已随 tasks 域删除），panelId 参数移除，仅保留 sid（壳侧按 focusedSessionId 路由，sid 透传无
 * 运行时消费）。
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
  /** 打开 drawer panel 并绑定 sid（side drawer 统一入口） */
  openPanel(sid: string): void
}
