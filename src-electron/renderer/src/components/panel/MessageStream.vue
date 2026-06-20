<template>
  <!--
    容器组件 · message-stream（panel/spec.md zone ②，draft-message-stream）。
    读 chat store 按 sessionId 分区的消息 → groupTurns 分回合 → 渲染 Turn 列表。
    auto-scroll 基础版（spec §8.5）：messages 变化 → scrollToBottom。
    高级行为（上滚暂停/跳底提示）DEFERRED（G2-007）。
    空 session 显示欢迎语（G2-004 空态收敛）。
  -->
  <div ref="scrollEl" class="message-stream flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-5 py-[18px]">
    <Turn v-for="turn in turns" :key="turn.index" :turn="turn" />

    <!-- 空态欢迎语（G2-004） -->
    <div v-if="turns.length === 0" class="m-auto flex flex-col items-center gap-2 text-center">
      <Sparkles class="size-6 text-accent opacity-70" />
      <p class="text-[13px] text-muted">开始对话，或从左侧选择一个会话</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { Sparkles } from '@lucide/vue'
import { useChatStore } from '@/stores/chat'
import { useChatScroll } from '@/composables/effects/useChatScroll'
import { groupTurns } from '@/composables/logic/messageTurns'
import Turn from './message-stream/Turn.vue'

const props = defineProps<{
  sessionId: string
}>()

const chat = useChatStore()

/**
 * 当前 session 的消息（响应式）。
 * 直接读 messages ref 的 Map.get 建立对 Map 的依赖（storeToRefs 等价），
 * appendUser/appendAssistantChunk 的 Map.set 触发更新。
 */
const currentMessages = computed(() => chat.messages.get(props.sessionId) ?? [])

/** 扁平消息 → 回合分组（纯函数） */
const turns = computed(() => groupTurns(currentMessages.value))

/** auto-scroll：监听 messages 长度 + streaming 内容变化 → 滚到底 */
const { scrollEl, scrollToBottom } = useChatScroll()

watch(
  () => currentMessages.value.length,
  () => {
    scrollToBottom('auto')
  },
)

// streaming 中 text 追加也触发滚动（按最后一条消息 content 长度）
watch(
  () => {
    const list = currentMessages.value
    const last = list[list.length - 1]
    return last?.content.length ?? 0
  },
  () => {
    if (turns.value[turns.value.length - 1]?.isWorking) {
      scrollToBottom('auto')
    }
  },
)

// 切换 session → 滚到底（展示最新内容）
watch(
  () => props.sessionId,
  () => scrollToBottom('auto'),
)
</script>

<style scoped>
/* message-stream 滚动条（draft） */
.message-stream::-webkit-scrollbar { width: 8px; }
.message-stream::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: 4px;
}
.message-stream::-webkit-scrollbar-thumb:hover { background: var(--subtle); }
</style>
