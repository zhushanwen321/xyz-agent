/**
 * composer dispatch 模块入口 —— core/domain/composer/dispatch/ 的公开 API 聚合（W3）。
 *
 * 定位：p3-strangler-domains::composer W3 产物。staging/submit/bash/send/fork-mode/handoff-mode
 * 六个 composable 迁入 core，经 deps 注入跨域能力（chatStore/useChat/useSidebar 等），零 renderer import。
 *
 * barrel 用 export * 自动 re-export 各模块已 export 的符号（函数 + 已 export 的 deps 接口）。
 * 未 export 的内部 deps 契约（ComposerSubmitDeps/ComposerSendDeps/ForkDeps/HandoffDeps）保留模块内，
 * 壳层构造 deps 时靠 TS 结构匹配推断（同 input 模块 ComposerInputInstance 分散定义范式）。
 */
export * from './staging'
export * from './submit'
export * from './bash'
export * from './send'
export * from './fork-mode'
export * from './handoff-mode'
