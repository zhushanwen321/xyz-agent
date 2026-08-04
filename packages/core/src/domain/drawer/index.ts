/**
 * drawer 域入口 —— @xyz-agent/core 的 drawer 域聚合 barrel。
 *
 * 子域：types（共享类型）/ control（per-session 控制态 + 分区键绑定 + 内部原语）/ coordination
 * （模块级公开 API + pendingOpen 守卫 + 瞬时参数）。W1 迁移 useSideDrawer 的控制态/协同逻辑
 * 入 core（drawer 域是第一个「迁实现而非仅迁类型」的域），core 保持 headless（零 pinia/tasks
 * store 依赖），分区键经 bindDrawerSessionId 注入、tasks 数据判定经 openTasksDrawerOnFirstData
 * 签名参数化解耦。承接架构文档 §10.2（旧层 → core/domain/* 映射）。
 *
 * 迁移过渡期（renderer 旧 SideDrawer 未删）：renderer useSideDrawer.ts 为 re-export 兼容层
 * （不持有业务状态），旧调用方零改动；core/domain/drawer 为 SSOT。
 *
 * 依赖方向（C4）：coordination → control → foundation/use-session-scoped-state，
 * control 不 import coordination（防循环）。
 */
export * from './types'
export * from './control'
export * from './coordination'
