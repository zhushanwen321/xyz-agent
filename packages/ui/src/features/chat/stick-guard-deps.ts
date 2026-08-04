/**
 * StickGuardDeps —— Turn.vue 的 trace 折叠 transition hooks inject token（w6 chat-ui-and-shell）。
 *
 * useStickGuard/useTraceTransition 是容器级编排（stick guard 由 MessageStream.vue 壳层
 * provide 发起，控制滚动锚定 + 折叠动画）。ui 内 Turn 经此 inject token 消费 transition hooks，
 * 不自持 stick guard 逻辑（对齐 design-review TD6：useStickGuard provide 留壳层，ui 经独立 inject 消费）。
 *
 * renderer 壳 MessageStream.vue provide(useTraceTransition(useStickGuard())) 的产物。
 */
import type { InjectionKey } from 'vue'
import { inject } from 'vue'

/** Transition hooks（Vue <Transition :css="false"> 的 before-leave/leave/enter） */
export interface StickGuardDeps {
  onTraceBeforeLeave: (el: Element) => void
  onTraceLeave: (el: Element, done: () => void) => void
  onTraceEnter: (el: Element, done: () => void) => void
}

export const StickGuardDepsKey: InjectionKey<StickGuardDeps> = Symbol('StickGuardDeps')

/** inject StickGuardDeps helper。token 缺失时抛错。 */
export function useStickGuardDeps(): StickGuardDeps {
  const deps = inject(StickGuardDepsKey)
  if (!deps) {
    throw new Error(
      '[StickGuardDeps] inject 缺失：Turn 必须在 provide StickGuardDepsKey 的容器（renderer 壳 MessageStream.vue）内渲染。',
    )
  }
  return deps
}
