<template>
  <!--
    容器组件 · message-stream（panel/spec.md zone ②，draft-message-stream）。
    读 chat store 按 sessionId 分区的消息 → groupTurns 分回合 → 渲染 Turn 列表。
    auto-scroll（spec §8.5 + G2-007）：stickToBottom 判定，上滚脱离锚定不强制拉回，
    非贴底有新内容显「回到底部」浮层，点浮层平滑滚回并恢复锚定。
    空 session 显示欢迎语（G2-004 空态收敛）。
  -->
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      ref="scrollEl"
      class="message-stream flex flex-1 flex-col gap-[22px] overflow-y-auto px-5 py-[18px]"
      @scroll.passive="onScroll"
    >
    <template v-for="(item, idx) in renderItems" :key="renderKey(item)">
      <Turn
        v-if="item.kind === 'turn'"
        :turn="item.turn"
        :session-id="sessionId"
        :can-edit="!!item.turn.user && idx === lastUserTurnIdx"
      />
      <SystemNotice v-else :message="item.message" />
    </template>

    <!-- 压缩中提示（瞬时态：isCompacting=true 时显示，完成后由 message.compactionSummary 持久化记录取代） -->
    <div v-if="isCompacting" class="system-notice flex items-center gap-2 py-1">
      <span class="h-px flex-1 bg-border" />
      <Loader2 class="size-3 shrink-0 animate-spin text-muted" />
      <span class="shrink-0 text-[11.5px] leading-snug text-muted">压缩中</span>
      <span class="h-px flex-1 bg-border" />
    </div>

    <!-- 空态欢迎语（G2-004） -->
    <div v-if="renderItems.length === 0" class="m-auto flex flex-col items-center gap-2 text-center">
      <Sparkles class="size-6 text-accent opacity-70" />
      <p class="text-[13px] text-muted">开始对话，或从左侧选择一个会话</p>
    </div>
    </div>

    <!-- 回到底部浮层：非贴底时显示（showJumpButton = 用户不在底部），点之平滑滚回并恢复锚定 -->
    <Transition name="fade">
      <Button
        v-if="showJumpButton"
        variant="default"
        size="icon"
        class="absolute bottom-4 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full shadow-lg"
        title="回到底部"
        @click="scrollToBottom('smooth', true)"
      >
        <ChevronDown class="size-4" />
      </Button>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { ChevronDown, Loader2, Sparkles } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chat'
import { useChatScroll } from '@/composables/effects/useChatScroll'
import { toRenderItems, renderKey } from '@/composables/logic/messageTurns'
import Turn from './message-stream/Turn.vue'
import SystemNotice from './message-stream/SystemNotice.vue'

const props = defineProps<{
  sessionId: string
}>()

const chat = useChatStore()

/**
 * 当前 session 的消息（响应式）。
 * 直接读 messages ref 的 Map.get 建立对 Map 的依赖（storeToRefs 等价），
 * appendUser/applyMessageEvent 的 Map.set 触发更新。
 */
const currentMessages = computed(() => chat.messages.get(props.sessionId) ?? [])

/** 当前 session 是否正在压缩（session.compacting → true，compacted → false）。
 *  驱动消息流末尾的「--- 压缩中 ---」瞬时提示。完成后 dispatcher 广播 message.compactionSummary，
 *  插入持久化 system 消息（SystemNotice 渲染「已压缩上下文」），isCompacting 同时复位为 false。 */
const isCompacting = computed(() => chat.isCompacting(props.sessionId))

/** 扁平消息 → 渲染项（turn + system 提示行穿插，纯函数） */
const renderItems = computed(() => toRenderItems(currentMessages.value))

/** 最后一个含 user 的 turn 的数组下标（只有它的 user 可编辑，避免编辑中间 user 丢失其后对话） */
const lastUserTurnIdx = computed(() => {
  for (let i = renderItems.value.length - 1; i >= 0; i -= 1) {
    const item = renderItems.value[i]
    if (item.kind === 'turn' && item.turn.user) return i
  }
  return -1
})

/** 渲染项里最后一个 turn（streaming 滚动判定用） */
const lastRenderTurn = computed(() => {
  for (let i = renderItems.value.length - 1; i >= 0; i -= 1) {
    const item = renderItems.value[i]
    if (item.kind === 'turn') return item.turn
  }
  return null
})

/**
 * auto-scroll：stickToBottom guard —— 非贴底时不强制拉回。
 * showJumpButton 驱动「回到底部」浮层显隐（= !stickToBottom，修复 W3：点击后上滑按钮重现）。
 * 注：useChatScroll 仍导出 unreadBelow（标记下方有未读新内容），本组件暂未使用故不解构。
 */
const { scrollEl, showJumpButton, onScroll, scrollToBottom } = useChatScroll()

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
    if (lastRenderTurn.value?.isWorking) {
      scrollToBottom('auto')
    }
  },
)

// 切换 session → 强制滚到底（展示最新内容，不受 guard）
watch(
  () => props.sessionId,
  () => scrollToBottom('auto', true),
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

/* 回到底部浮层过渡 */
.fade-enter-active, .fade-leave-active { transition: opacity var(--duration-fast, 150ms) ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
