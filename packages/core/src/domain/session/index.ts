/**
 * session 域入口 —— @xyz-agent/core 的 session 列表域（p3-strangler-domains W1）。
 *
 * 承接架构文档 §10.2（旧层 → core/domain/* 映射）：renderer stores/session.ts 迁移为
 * 纯 factory createSessionStore；IF2 SessionApiPort（TC2 后端通道）；IF3 panel 编排契约
 * （C-SS-3，openPanelOnSessionEvent + pendingOpen 路由）。renderer 消费方迁移为后续
 * WorkUnit，旧 store/composable 保留至消费方全部迁移后删除（strangler 逐域绞杀）。
 */
export * from './store'
export * from './api-port'
export type { PanelOrchestrationPort } from './effects/panel-orchestration'
export {
  setPendingOpenForSid,
  getPendingOpenForSid,
  openPanelOnSessionEvent,
  consumePendingOpen,
} from './effects/panel-orchestration'
