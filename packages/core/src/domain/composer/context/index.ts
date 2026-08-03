/**
 * composer context 模块入口 —— core/domain/composer/context/ 的公开 API 聚合（W3）。
 *
 * 定位：p3-strangler-domains::composer W3 产物。三个模块迁入 core：
 * - injection-store：drawer 注入的「一次性消息通道」store（createComposerInjectionStore factory 范式）
 * - context-chips：Composer 顶部「已附上下文」chip 行状态派生
 * - injection：Composer 侧消费注入请求（target 路由 + file/text chip 注入）
 *
 * barrel 用 export * 自动 re-export 各模块已 export 的符号。InjectionDeps 从 injection.ts export，
 * PendingInjection/InjectionRequest/InjectionTarget/ComposerInjectionStore/PendingInjectionRef 从 injection-store export。
 */
export * from './context-chips'
export * from './injection-store'
export * from './injection'
// ComposerInputInstance 权威定义在 input/types.ts（input 模块 export），此处 re-export 供
// context 消费者（shim/壳层）从统一入口取，避免两处同名类型分裂（TS2308 冲突）。
export type { ComposerInputInstance } from '../input/types'
