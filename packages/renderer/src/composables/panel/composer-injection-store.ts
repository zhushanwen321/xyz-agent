/**
 * composer-injection-store.ts —— renderer 侧模块级单例（W4 composer-shell-integration）。
 *
 * [归位] 状态逻辑在 @xyz-agent/core/domain/composer/context/injection-store.ts（W3）的
 * createComposerInjectionStore() factory（core 零 pinia 依赖）。原 renderer stores/composer-injection.ts
 * 是 defineStore wrapper（pinia 注册，W3 过渡），W4 删除 wrapper，改为模块级单例持有 core factory
 * 实例——保持 pinia 单例语义（drawer 写入 + composer 消费共享同一 pendingInjection 通道）。
 *
 * 消费者（TerminalView/GitPanel/DetailPane + Composer 壳 useComposerShell）：
 * 调用形态与旧 pinia store 完全一致（requestInjection/clearInjection/routeToLanding + pendingInjection），
 * 仅 import 路径变化（本文件替代 stores/composer-injection.ts）。
 *
 * 注意：pendingInjection 是 core factory 的 ref（.value 消费），pinia store 解包语义已不存在
 * （core factory 直接返回 Ref 形态，无需 storeToRefs）。
 */
import { createComposerInjectionStore } from '@xyz-agent/core/domain/composer/context'

/** 模块级单例（drawer 写入方与 composer 消费方共享同一实例，一次性消息通道语义） */
export const composerInjectionStore = createComposerInjectionStore()

/** 兼容函数：返回同一单例实例（保持旧 useComposerInjectionStore() 调用形态） */
export function useComposerInjectionStore(): ReturnType<typeof createComposerInjectionStore> {
  return composerInjectionStore
}

export type { InjectionTarget, PendingInjection, InjectionRequest } from '@xyz-agent/core/domain/composer/context'
