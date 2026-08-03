/**
 * chat store —— defineStore 薄包装（P3 chat 域绞杀 w4）。
 *
 * [归位] store 主体逻辑（messages 分区 / isGenerating 派生 / finalizeSession 收口 /
 * pendingSend 生命周期 / LRU 驱逐 / changeset / handoff / retry-queue 子域）已迁
 * @xyz-agent/core/domain/chat/store.ts 的 createChatStore factory（IF1 契约）。
 * 本文件仅做两件事：
 *
 * 1. defineStore('chat', () => createChatStore(deps)) 注册到 pinia（core 不绑 store id，
 *    pinia store 注册是 shell 关切，factory + wrapper 模式对齐 handoff IF1）。
 * 2. 注入 openTasksPanelOnFirstData 回调（唯一 renderer 跨域依赖：首数据到达开 tasks panel）。
 *    回调衔接 renderer 自己的 useSideDrawer/usePanelStore/setPendingOpenForSid，保持
 *    pendingOpenMap 单一在 renderer 侧（避免 core/renderer Map 分裂，w3 clarify Q5 模式）。
 *
 * ~30 个 useChatStore 消费方 import '@/stores/chat' 不变（factory + wrapper 模式下
 * useChatStore 仍在 renderer，零消费方 churn）。
 *
 * 历史：原文件 906 行（defineStore setup 函数体 + 10 个模块级 helper），w4 全部迁 core。
 * re-export（DEFAULT_STREAMING_TIMEOUT_MS / LRU_MAX_SESSIONS / RetryState / QueueState /
 * FinalizeReason）保持消费方兼容（chat-streaming-timeout.test.ts / chat-lru.test.ts /
 * RetryIndicator.vue / QueueBubble.vue 等）。
 */
import { defineStore } from 'pinia'
import { createChatStore, useTasksStore } from '@xyz-agent/core'
import { useSideDrawer, setPendingOpenForSid } from '@/composables/features/useSideDrawer'
import { usePanelStore } from '@/stores/panel'

export const useChatStore = defineStore('chat', () =>
  createChatStore({
    // 首个 todo/goal 数据到达时开 tasks panel（原 chat-message-effects.openTasksDrawerOnFirstData
    // 逐字逻辑，core effects/registry 的 routeToolResultToTasks/routeToolStartToTasks 写入
    // tasks store 后调 ctx.openTasksPanelOnFirstData(sid, hadDataBefore)，本回调经 deps 注入透传）。
    openTasksPanelOnFirstData: (sid: string, hadDataBefore: boolean): void => {
      if (hadDataBefore) return // 已有数据，非首次
      const tasksStore = useTasksStore()
      if (!tasksStore.hasData(sid)) return // 写入后仍无数据（守卫，理论上不达）
      const focusedSid = usePanelStore().focusedSessionId
      if (focusedSid === sid) {
        useSideDrawer().open('tasks')
      } else {
        setPendingOpenForSid(sid)
      }
    },
  }),
)

// re-export 供外部消费（测试 / 组件读常量与类型），保持原 chat.ts 的 export 形状
export { DEFAULT_STREAMING_TIMEOUT_MS, LRU_MAX_SESSIONS } from '@xyz-agent/core'
export type { RetryState, QueueState, FinalizeReason } from '@xyz-agent/core'
