<script setup lang="ts">
/**
 * MessageStream —— 移动端 chat 消息流容器（spec P4 D5）。
 *
 * 复用桌面端 message-stream 渲染链路：读 chat store 按 sessionId 分区的消息 →
 * filterDisplayableMessages + toRenderItems 分组为 turn / system 提示行 →
 * 渲染复用的 message-stream/Turn.vue（markdown、代码块、tool call 卡片、thinking 折叠）。
 *
 * 与桌面 MessageStream.vue 的差异（移动端裁剪，spec D7 / D11）：
 * - 不引入 virtua 虚拟滚动（移动端会话消息量小，且移动 viewport 行为不同），
 *   改用普通 v-for + overflow-y-auto。
 * - 不引入 TurnRail（右侧导航 rail，桌面专属 hover 交互，移动端无对应概念）。
 * - 不引入 useStreamingPin / useVirtuaFollow / useMessageStreamRail 等桌面虚拟滚动配套 composable。
 * - auto-scroll 采用轻量实现：贴底检测 + 「回到底部」浮层（仅基础滚到底部，无 virta 跟随状态机）。
 * 子组件（Turn / Block / MarkdownRenderer 等）与桌面端共享同一渲染逻辑（移动端适配副本），
 * 保证 markdown / 代码块 / tool call 结果 / thinking 折叠的渲染一致性。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Sparkles } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chat'
import { useSessionActive } from '@/composables/panel/useSessionActive'
import { filterDisplayableMessages, toRenderItems } from '@/composables/logic/messageTurns'
import Turn from './message-stream/Turn.vue'
import SystemNotice from './message-stream/SystemNotice.vue'
import BgNotifyCard from './message-stream/BgNotifyCard.vue'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()
const chat = useChatStore()

/** 当前 session 的消息（chat store 的 messages Map 按 sessionId 分区）。
 *  getMessages 读 shallowRef<Map>，computed 在此建立响应式依赖。 */
const currentMessages = computed(() => chat.getMessages(props.sessionId) ?? [])

/** session id（useSessionActive 形参类型 Ref<string|null>，故显式 nullable）。 */
const sessionIdRef = computed<string | null>(() => props.sessionId)

/** 移动端无 subagent 虚拟 session 强制流式需求，forceWorking 恒 false（与桌面签名对齐）。 */
const forceWorking = computed(() => false)

/** session 级「对话进行中」信号（驱动 Turn sticky/折叠 disabled/trace 展开等）。 */
const isSessionActive = useSessionActive(sessionIdRef, forceWorking)

/** 扁平消息 → 渲染项（turn + system 提示行穿插，纯函数）。 */
const renderItems = computed(() =>
  toRenderItems(filterDisplayableMessages(currentMessages.value), false),
)

/** 最后一个含 user 的 turn 的数组下标（仅它可编辑，避免编辑中间 user 丢失其后对话）。 */
const lastUserTurnIdx = computed(() => {
  for (let i = renderItems.value.length - 1; i >= 0; i -= 1) {
    const item = renderItems.value[i]
    if (item.kind === 'turn' && item.turn.user) return i
  }
  return -1
})

/** 滚动容器 el。auto-scroll 贴底检测 + 「回到底部」浮层用。 */
const scrollEl = ref<HTMLElement | null>(null)

/** 当前是否贴底（距底 ≤ 阈值视为贴底，跟随新消息自动滚到底）。 */
const stickToBottom = ref(true)
/** 是否显示「回到底部」浮层（非贴底且有消息时）。 */
const showJumpButton = computed(
  () => renderItems.value.length > 0 && !stickToBottom.value,
)

const STICK_THRESHOLD = 80

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  stickToBottom.value = distance <= STICK_THRESHOLD
}

/** 平滑滚到底部，并恢复贴底锚定。 */
function scrollToBottom(smooth: boolean): void {
  const el = scrollEl.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  stickToBottom.value = true
}

/** 贴底时跟随新内容滚到底（流式追加 / 新 turn / notice 显隐触发）。 */
function followIfStuck(): void {
  if (stickToBottom.value) scrollToBottom(false)
}

/** 消息条数变化（新 turn 追加）时跟随。 */
watch(
  () => renderItems.value.length,
  () => nextTick(followIfStuck),
)

/** 流式 text 追加（不增条数，只更新最后一条 turn 内容）时跟随。
 *  监听最后一条消息的 content 长度变化即可覆盖流式追加。 */
watch(
  () => {
    const msgs = currentMessages.value
    const last = msgs[msgs.length - 1]
    return last ? String(last.content ?? '').length : 0
  },
  () => nextTick(followIfStuck),
)

/** 挂载时滚到底部展示最新内容。 */
onMounted(() => scrollToBottom(false))

/** 切换 session：nextTick 后滚到底部展示最新内容。 */
watch(
  () => props.sessionId,
  () => nextTick(() => scrollToBottom(false)),
)

/** editing turn 滚出视口会卸载丢失 Turn.vue 的 draftText，移动端消息量小不虚拟化，无需钉扎处理。
 *  这里仅为对齐桌面接口占位（Turn emit edit-state-change，本容器不消费）。 */
function onEditStateChange(_idx: number, _editing: boolean): void {
  // no-op：移动端不虚拟化，编辑态 turn 恒挂载，无需钉扎。
}
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      ref="scrollEl"
      class="message-stream relative flex-1 overflow-y-auto px-3 pt-4"
      data-testid="mobile-message-stream-scroll"
      @scroll="onScroll"
    >
      <!-- 空态欢迎语：独立于消息列表，撑满视口居中。 -->
      <div
        v-if="renderItems.length === 0"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
        data-testid="mobile-message-stream-empty"
      >
        <Sparkles class="size-6 text-accent opacity-70" />
        <p class="text-sm text-muted">{{ t('panel.message.startConversation') }}</p>
      </div>

      <!-- 消息列表：turn / system 穿插渲染（复用桌面 message-stream/Turn + SystemNotice）。 -->
      <div v-else class="flex flex-col">
        <template v-for="(item, index) in renderItems" :key="item.kind === 'turn' ? `t-${item.turn.index}` : `s-${item.message.id}`">
          <Turn
            v-if="item.kind === 'turn'"
            :turn="item.turn"
            :session-id="props.sessionId"
            :can-edit="!!item.turn.user && index === lastUserTurnIdx"
            :is-session-active="isSessionActive"
            @edit-state-change="onEditStateChange(index, $event.editing)"
          />
          <BgNotifyCard v-else-if="item.message.bgNotify" :message="item.message" />
          <SystemNotice v-else :message="item.message" />
        </template>
      </div>
    </div>

    <!-- 回到底部浮层：非贴底时显示，点之平滑滚回并恢复锚定。 -->
    <Transition name="fade">
      <Button
        v-if="showJumpButton"
        variant="default"
        size="icon"
        class="absolute bottom-4 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full shadow-lg"
        data-testid="mobile-message-stream-jump"
        :title="t('panel.message.scrollToBottom')"
        @click="scrollToBottom(true)"
      >
        <ChevronDown class="size-4" />
      </Button>
    </Transition>
  </div>
</template>

<style scoped>
/* message-stream 滚动条样式（与桌面端一致，移动浏览器仍渲染自定义滚动条）。 */
.message-stream::-webkit-scrollbar { width: 8px; }
.message-stream::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: 4px;
}
.message-stream::-webkit-scrollbar-thumb:hover { background: var(--neutral-dim); }

/* 回到底部浮层过渡。 */
.fade-enter-active, .fade-leave-active { transition: opacity var(--duration-fast, 150ms) ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
