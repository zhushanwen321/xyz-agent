/**
 * useComposerInjection —— deps 组装 shim（W3 composer-dispatch-context）。
 *
 * [归位] 逻辑已迁 @xyz-agent/core/domain/composer/context/injection.ts（W3）。
 * core 版重构签名为 (inputRef, sessionId, variant, deps)，4 个跨域能力
 * （injectionStore/startFlow/getSessionCwd/getActiveSessionId）经 deps 注入
 * （core 零 renderer import）。本 shim 保持旧签名（3 参），内部从 renderer
 * store/composable 组装 deps 调 core 版。
 *
 * injectionStore 用 storeToRefs 把 pinia store 解包后的 pendingInjection 包回
 * Ref 形态（core 消费 .value）；方法直接绑定 store 实例。
 *
 * 旧调用方（Composer.vue）零改动。
 *
 * W4 壳接入时删除本 shim。
 */
import { storeToRefs } from 'pinia'
import { useComposerInjectionStore } from '@/stores/composer-injection'
import { useSessionStore } from '@/stores/session'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import {
  useComposerInjection as useCoreComposerInjection,
  type ComposerInputInstance,
  type InjectionDeps,
} from '@xyz-agent/core/domain/composer/context'

export function useComposerInjection(
  inputRef: import('vue').Ref<ComposerInputInstance | null>,
  sessionId: import('vue').Ref<string | null>,
  variant: import('vue').Ref<'panel' | 'landing'>,
): void {
  const store = useComposerInjectionStore()
  const sessionStore = useSessionStore()
  const flow = useNewTaskFlow()
  const { pendingInjection } = storeToRefs(store)
  const deps: InjectionDeps = {
    injectionStore: {
      pendingInjection,
      requestInjection: store.requestInjection,
      clearInjection: store.clearInjection,
      routeToLanding: store.routeToLanding,
    },
    startFlow: (cwd?: string) => flow.startFlow(cwd),
    getSessionCwd: (sid: string) => sessionStore.list.find((s) => s.id === sid)?.cwd ?? undefined,
    getActiveSessionId: () => sessionStore.active?.id ?? null,
  }
  return useCoreComposerInjection(inputRef, sessionId, variant, deps)
}
