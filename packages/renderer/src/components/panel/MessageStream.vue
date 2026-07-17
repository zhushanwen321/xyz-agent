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
      class="message-stream flex-1 overflow-y-auto"
      @scroll.passive="onScroll"
    >
    <!-- contentEl：承载消息内容的 wrapper，供 useChatScroll 的 ResizeObserver 观察高度变化。
         scrollEl 是 overflow 容器，自身 border-box 固定不变，无法观察内容增高。 -->
    <div ref="contentEl" class="flex flex-col gap-[22px] px-5 py-[18px]">
      <!-- W4 H4：加载更多历史入口（尾读截断时显示，点击 fallback 全量读） -->
      <div v-if="showLoadMore && renderItems.length > 0" class="flex justify-center py-2">
        <Button variant="ghost" size="sm" :disabled="loadingMore" data-testid="load-more-history" @click="handleLoadMore">
          <Loader2 v-if="loadingMore" class="mr-1 size-3 animate-spin" />
          <ChevronUp v-else class="mr-1 size-3" />
          {{ loadingMore ? t('common.loading') : t('panel.message.loadMore') }}
        </Button>
      </div>
      <template v-for="(item, idx) in renderItems" :key="renderKey(item)">
        <Turn
          v-if="item.kind === 'turn'"
          :turn="item.turn"
          :session-id="sessionId"
          :can-edit="!!item.turn.user && idx === lastUserTurnIdx"
        />
        <BgNotifyCard v-else-if="item.message.bgNotify" :message="item.message" />
        <!-- 结构化 GUI 组件（extension GUI 协议 E5：customMessage 的 details.__gui__）。
             customStart 把 details（含 __gui__）存进 system 消息，此处检测并路由到
             GuiComponentRenderer；无 __gui__ 则落到下面的 SystemNotice 纯文本兜底。
             容器样式与 SystemNotice 视觉一致（左内边距、等宽字体），用通用 Tailwind 类。 -->
        <div
          v-else-if="getGuiComponent(item.message)"
          class="py-1 pl-1 font-mono text-[12px] leading-snug text-fg"
        >
          <GuiComponentRenderer :component="getGuiComponent(item.message)!" />
        </div>
        <SystemNotice v-else :message="item.message" />
      </template>

      <!-- 压缩中提示（瞬时态：isCompacting=true 时显示，完成后由 message.compactionSummary 持久化记录取代） -->
      <div v-if="isCompacting" class="system-notice flex min-w-0 items-center gap-2 py-1">
        <span class="h-px flex-1 bg-border" />
        <Loader2 class="size-3 shrink-0 animate-spin text-muted" />
        <span class="min-w-0 truncate text-[11px] leading-snug text-muted">{{ t('panel.message.compressing') }}</span>
        <span class="h-px flex-1 bg-border" />
      </div>

      <!-- dispatching 空窗期占位：已发送（pendingSend 命中）但 message_start 未到。
           message_start 到达后 hasWorkingTurn 变 true，占位消失，由 working turn 的 sticky header 接管。
           纯 UI 瞬时反馈，不插入 assistant message 污染消息历史。 -->
      <div v-if="isDispatching && !hasWorkingTurn" class="flex items-center gap-2 py-2 pl-1 text-[12px] text-muted">
        <Loader2 class="size-3 animate-spin text-accent" />
        <span>{{ t('panel.message.dispatching') }}</span>
      </div>

      <!-- 空态欢迎语（G2-004） -->
      <div v-if="renderItems.length === 0" class="m-auto flex flex-col items-center gap-2 text-center">
        <Sparkles class="size-6 text-accent opacity-70" />
        <p class="text-[13px] text-muted">{{ t('panel.message.startConversation') }}</p>
      </div>
    </div>
    </div>

    <!-- 回到底部浮层：非贴底时显示（showJumpButton = 用户不在底部），点之平滑滚回并恢复锚定 -->
    <Transition name="fade">
      <Button
        v-if="showJumpButton"
        variant="default"
        size="icon"
        class="absolute bottom-4 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full shadow-lg"
        :title="t('panel.message.scrollToBottom')"
        @click="scrollToBottom('smooth', true)"
      >
        <ChevronDown class="size-4" />
      </Button>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Loader2, Sparkles } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chat'
import { useChat } from '@/composables/features/useChat'
import { useChatScroll } from '@/composables/effects/useChatScroll'
import { toRenderItems, renderKey } from '@/composables/logic/messageTurns'
import { isSubagentVirtualId, extractSubagentId } from '@/stores/subagent'
import { useSubagentStore } from '@/stores/subagent'
import Turn from './message-stream/Turn.vue'
import SystemNotice from './message-stream/SystemNotice.vue'
import BgNotifyCard from './message-stream/BgNotifyCard.vue'
import GuiComponentRenderer from './message-stream/GuiComponentRenderer.vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { extractGui } from '@xyz-agent/extension-protocol'
import type { Message } from '@xyz-agent/shared'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const chat = useChatStore()
const { loadMoreHistory, hasMoreHistory: checkHasMore } = useChat()
const subagentStore = useSubagentStore()

/** W4 H4：加载更多历史 loading 状态 */
const loadingMore = ref(false)
/** N1: 是否有更多历史可加载（由 hydrate 的 historyTruncated 标志驱动，非默认 true） */
const showLoadMore = computed(() => checkHasMore(props.sessionId))

async function handleLoadMore(): Promise<void> {
  if (loadingMore.value || !showLoadMore.value) return
  loadingMore.value = true
  try {
    await loadMoreHistory(props.sessionId)
    // loadMoreHistory 内部 clearHistoryTruncated 会更新 showLoadMore
  } finally {
    loadingMore.value = false
  }
}

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

/**
 * dispatching 空窗期：已发送 prompt（pendingSend 命中本 session）但 message_start 未到。
 * 此时 MessageStream 内无 streaming assistant，用户看不到任何反馈。
 * 占位行给出即时「思考中…」提示，message_start 到达后 hasWorkingTurn 变 true 接管。
 */
const isDispatching = computed(() => chat.isActive(props.sessionId) && !chat.isGenerating(props.sessionId))
/** 最后一个 turn 是否正在 working（message_start 已到，有 streaming assistant） */
const hasWorkingTurn = computed(() => lastRenderTurn.value?.isWorking ?? false)

/**
 * subagent 虚拟 session 且 subagent 仍在 running 时，强制最后一个 turn working。
 * subagent 消息读自 JSONL（status 恒 complete），但 subagent 可能仍在执行中——
 * forceWorking 让 trace 展开，视觉与主 agent streaming 态一致。
 * 读 subagentStore.records（共享列表），store getter isRunning 判断状态。
 */
const forceWorking = computed(() => {
  if (!isSubagentVirtualId(props.sessionId)) return false
  const subagentId = extractSubagentId(props.sessionId)
  return subagentStore.isRunning(subagentId)
})

/** 扁平消息 → 渲染项（turn + system 提示行穿插，纯函数） */
const renderItems = computed(() => toRenderItems(currentMessages.value, forceWorking.value))

/**
 * 从 system 消息的 details.__gui__ 提取结构化渲染组件（extension GUI 协议 E5）。
 * customStart 把含 __gui__ 的 details 存进 system 消息；无 __gui__ 返回 undefined，
 * 由模板落回 SystemNotice 纯文本兜底。封装为函数避免模板里重复调用 extractGui。
 */
function getGuiComponent(message: Message): GuiComponent | undefined {
  return extractGui(message.details)?.component
}

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
 * contentEl 绑定内容 wrapper，供 useChatScroll 的 ResizeObserver 观察异步渲染抖动。
 * 注：useChatScroll 仍导出 unreadBelow（标记下方有未读新内容），本组件暂未使用故不解构。
 */
const { scrollEl, contentEl, showJumpButton, onScroll, scrollToBottom } = useChatScroll()

/**
 * 首次挂载强制滚到底（force=true 绕过 guard）。
 * MessageStream 经 v-if 条件挂载，首次挂载时 sessionId 已是目标值，session watch 不触发
 * （watch 监听变化，挂载不算变化）；不显式滚则停在 scrollTop=0（最上方）。
 * 异步渲染导致的 scrollHeight 抖动由 ResizeObserver 兜底，此处只做首次定位 + 校准 showJumpButton。
 */
onMounted(() => {
  scrollToBottom('auto', true)
})

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
