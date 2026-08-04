/**
 * new-task-search 域入口 —— @xyz-agent/core 的搜索/命令/文件候选域（p3-strangler-domains W1）。
 *
 * 承接架构文档 §10.2（旧层 → core/domain/* 映射）：renderer lib/search-types + match-engine +
 * file-candidates + file-match 下沉为本域类型/纯函数模块；renderer stores/command.ts + fileSearch.ts
 * 迁移为纯 factory。renderer 消费方迁移为后续 WorkUnit，旧文件保留至消费方全部迁移后删除
 * （strangler 逐域绞杀）。
 */
export * from './types'
export * from './match-engine'
export * from './file-candidates'
export * from './file-match'
export * from './command-store'
export * from './file-search-store'
export * from './ports'
export * from './flow-state'
export * from './branch'
export * from './dir-select'
export * from './flow'
