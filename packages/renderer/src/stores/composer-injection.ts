/**
 * composer-injection store —— W3 shim（defineStore wrapper）。
 *
 * [归位] 逻辑已迁 @xyz-agent/core/domain/composer/context/injection-store.ts（W3），
 * 改为 createComposerInjectionStore() factory（core 零 pinia 依赖，store id 绑定是
 * shell 关切）。本文件是 renderer 侧薄 wrapper：defineStore 包装 factory，
 * 对外暴露的 API（useComposerInjectionStore / InjectionTarget / PendingInjection /
 * InjectionRequest）与旧版完全一致。
 *
 * 旧调用方（DetailPane/DiffView/GitPanel/useComposerInjection）零改动。
 *
 * W4 壳接入时删除本 wrapper。
 */
import { defineStore } from 'pinia'
import { createComposerInjectionStore } from '@xyz-agent/core/domain/composer/context'

export type { InjectionTarget, PendingInjection, InjectionRequest } from '@xyz-agent/core/domain/composer/context'

export const useComposerInjectionStore = defineStore('composer-injection', () =>
  createComposerInjectionStore(),
)
