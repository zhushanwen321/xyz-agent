/**
 * composer 域入口 —— @xyz-agent/core 的 composer 域聚合 barrel。
 *
 * 子域：types（共享类型）/ input（contenteditable 输入）/ dispatch（提交 + staging + fork/handoff 编排）/
 * context（注入通道 + 上下文 chip）/ model-thinking（模型 + 思考等级）/ thinking-level-sync（思考档同步）/
 * thinking-levels（思考档枚举与解析）。W3 后全域迁入 core，零 renderer import，跨域能力经 deps 注入。
 * 承接架构文档 §10.2（旧层 → core/domain/* 映射）。
 */
export * from './types'
export * from './input'
export * from './dispatch'
export * from './context'
export * from './model-thinking'
export * from './thinking-level-sync'
export * from './thinking-levels'
