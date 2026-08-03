/**
 * composer 域入口 —— @xyz-agent/core 的 composer 域（p3-strangler-domains W1 骨架）。
 *
 * 当前仅导出类型（types.ts）；实现（useComposerStaging 等策略编排）仍在 renderer，
 * 待旧 Composer 删除后归位。承接架构文档 §10.2（旧层 → core/domain/* 映射）。
 */
export * from './types'
export * from './input'
