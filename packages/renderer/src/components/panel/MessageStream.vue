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
      class="message-stream relative flex-1 overflow-y-auto pt-5"
      @scroll.passive="handleScroll"
    >
    <!-- 空态欢迎语（G2-004）：独立于虚拟列表 spacer，作为 scrollEl 直接子节点撑满视口。
         contentEl 在空会话时 height=0（totalHeight=0），若空态放其内部 absolute inset-0 会随之塌陷。 -->
    <div v-if="renderItems.length === 0" class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
      <Sparkles class="size-6 text-accent opacity-70" />
      <p class="text-[13px] text-neutral-mid">{{ t('panel.message.startConversation') }}</p>
    </div>
    <!-- contentEl：虚拟滚动 spacer，高度=totalHeight+topOffset 撑出滚动条。
         useChatScroll 的 ResizeObserver 观测它（totalHeight 变化→末项增高→触发 scrollToBottom）。
         可见 items 用 absolute 定位到各自 offset（+ topOffset 预留顶部 load-more 空间），视口外不挂载（虚拟化核心）。
         上下留白分工（统一 20px，全 user 气泡上方间距一致）：
         - 顶部留白：scrollEl 的 pt-5（首条 user 气泡距视口顶 20px）
         - turn 间距 + 末条到 composer：Turn.vue 的 pb-5（每条 user 气泡距上一个 AI 回复 20px，末条到 composer 20px）
         此处不放 py-5——abs 子元素包含块是本元素 padding box，padding 会被 abs 覆盖无效（曾因此致首条消息贴顶）。
         px-5 保留：与 abs 子元素 left-5/right-5 同档 20px，视觉对齐参考。 -->
    <div ref="contentEl" class="relative px-5" :style="{ height: totalHeight + topOffset + 'px' }">
      <!-- W4 H4：加载更多历史入口（abs 定位 top=0，所有 turn offset 加 topOffset 预留空间防遮挡） -->
      <!-- ref 供 dev-only 断言：实测高度 vs LOAD_MORE_RESERVED_HEIGHT 常量漂移检测（见下方 assertConstantHeights）。 -->
      <div
        v-if="showLoadMore && renderItems.length > 0"
        ref="loadMoreEl"
        class="absolute left-5 right-5 top-0 flex justify-center py-2"
      >
        <Button variant="ghost" size="sm" :disabled="loadingMore" data-testid="load-more-history" @click="handleLoadMore">
          <Loader2 v-if="loadingMore" class="mr-1 size-3 animate-spin" />
          <ChevronUp v-else class="mr-1 size-3" />
          {{ loadingMore ? t('common.loading') : t('panel.message.loadMore') }}
        </Button>
      </div>
      <!-- 虚拟化：只渲染 visibleRange 内的 items，absolute 定位到各自 offset + topOffset -->
      <!-- key 拼 sessionId 前缀：renderKey 在 turn.index/system.id 维度唯一，但跨 session/subagent
           虚拟 id 全局唯一性无保证，拼前缀做命名空间隔离防 Vue 复用错位。同 session 内 key 仍唯一。 -->
      <template v-for="vi in visibleItems" :key="`${sessionId}-${vi.key}`">
        <div class="absolute left-5 right-5" :style="{ top: offsetOf(vi.idx) + topOffset + 'px' }">
          <Turn
            v-if="vi.item.kind === 'turn'"
            :turn="vi.item.turn"
            :session-id="sessionId"
            :can-edit="!!vi.item.turn.user && vi.idx === lastUserTurnIdx"
            :is-session-active="isSessionActive"
            @edit-state-change="onEditStateChange(vi.idx, $event.editing)"
          />
          <BgNotifyCard v-else-if="vi.item.message.bgNotify" :message="vi.item.message" />
          <!-- bash 执行结果气泡（composer-bash-execute W3）：role:'system' + bashExecution -->
          <BashOutputBlock
            v-else-if="vi.item.message.bashExecution"
            :message="vi.item.message"
            :session-id="sessionId"
          />
          <!-- 结构化 GUI 组件（extension GUI 协议 E5：customMessage 的 details.__gui__）。 -->
          <div
            v-else-if="extractGuiComponent(vi.item.message)"
            class="py-1 pl-1 font-mono text-[12px] leading-snug text-neutral-fg"
          >
            <GuiComponentRenderer :component="extractGuiComponent(vi.item.message)!" />
          </div>
          <SystemNotice v-else :message="vi.item.message" />
        </div>
      </template>

      <!-- 压缩中提示（瞬时态：isCompacting=true 时显示，完成后由 message.compactionSummary 持久化记录取代）。
           非虚拟化，absolute 定位到列表末尾（+ topOffset）。
           ref 供 dev-only 断言：实测高度 vs COMPACTING_NOTICE_HEIGHT 常量漂移检测（见下方 assertConstantHeights）。 -->
      <div
        v-if="isCompacting"
        ref="compactingNoticeEl"
        class="system-notice absolute left-5 right-5 flex min-w-0 items-center gap-2 pt-2.5 pb-5"
        :style="{ top: totalHeight + topOffset + 'px' }"
      >
        <span class="h-px flex-1 bg-border" />
        <Loader2 class="size-3 shrink-0 animate-spin text-neutral-mid" />
        <span class="min-w-0 truncate text-[11px] leading-snug text-neutral-mid">{{ t('panel.message.compressing') }}</span>
        <span class="h-px flex-1 bg-border" />
      </div>

      <!-- 正在交接提示（fast-handoff 瞬时态）：isHandingOff=true 时显示在压缩中块之后。
           完成经 session.handoffComplete 广播跳转新 session，isHandingOff 同步复位。
           非虚拟化，absolute 定位到列表末尾 + topOffset + compacting 占位高度。 -->
      <div
        v-if="isHandingOff"
        class="system-notice absolute left-5 right-5 flex min-w-0 items-center gap-2 pt-2.5 pb-5"
        :style="{ top: handoffNoticeTop + 'px' }"
      >
        <span class="h-px flex-1 bg-border" />
        <Loader2 class="size-3 shrink-0 animate-spin text-neutral-mid" />
        <span class="min-w-0 truncate text-[11px] leading-snug text-neutral-mid">{{ t('panel.message.handing') }}</span>
        <Button
          variant="ghost"
          size="sm"
          class="h-auto p-0 text-[11px] text-neutral-mid hover:text-neutral-fg"
          data-testid="handoff-cancel-btn"
          @click="onAbortHandoff"
        >{{ t('panel.message.cancel') }}</Button>
        <span class="h-px flex-1 bg-border" />
      </div>

      <!-- dispatching 空窗期占位（非虚拟化，absolute 定位到列表末尾 + topOffset）。
           top 计入 compacting + handoff 占位高度，避免与上方瞬时块重叠。 -->
      <div
        v-if="isDispatching && !hasWorkingTurn"
        class="absolute left-5 right-5 flex items-center gap-2 py-2 pl-1 text-[12px] text-neutral-mid"
        :style="{ top: dispatchingTop + 'px' }"
      >
        <Loader2 class="size-3 animate-spin text-accent" />
        <span>{{ t('panel.message.dispatching') }}</span>
      </div>

      <!-- ForkNotice 反馈行（transient，非虚拟化，RV1）。
           fork 成功 / 后台分支状态变化时经 session.forkNotice 广播插入。
           绝对定位到列表末尾 + topOffset + compacting/dispatching 占位高度；多条通知垂直堆叠。
           不写 chat store messages（transient，不持久化不进 JSONL）。 -->
      <template v-if="forkNotices.length > 0">
        <div
          v-for="(notice, idx) in forkNotices"
          :key="notice.id"
          class="absolute left-5 right-5 py-1"
          :style="{ top: forkNoticeTop(idx) + 'px' }"
        >
          <ForkNotice
            :branch-name="notice.branchName"
            :preview="notice.preview"
            :kind="notice.kind"
            :session-deleted="notice.sessionDeleted ?? false"
            @view="onForkNoticeView(notice.newSessionId)"
            @dismiss="onForkNoticeDismiss(notice.id)"
          />
        </div>
      </template>
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

    <!-- TurnRail（w4 wave IF4）：右侧导航 rail，hover 弹出 turn 列表 + viewport indicator。
         纯展示组件，展开态/activeTurnIndex/事件全路由到此层（useTurnExpansion 与 Turn.vue 共享）。 -->
    <TurnRail
      :turns="railTurns"
      :active-turn-index="activeTurnIndex"
      :session-active="isSessionActive"
      :panel-right-edge="panelRightEdge"
      :expanded-turns="expandedTurns"
      @jump="onJump"
      @toggle="onToggle"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Loader2, Sparkles } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chat'
import { useChatScroll } from '@/composables/effects/useChatScroll'
import { useSettlingGuard } from '@/composables/effects/useSettlingGuard'
import { useVirtualTurnList } from '@/composables/effects/useVirtualTurnList'
import { useConstantHeightAssert } from '@/composables/effects/useConstantHeightAssert'
import { provideTurnResizeRegistry } from '@/composables/effects/useResizeReport'
import { provideStickGuard } from '@/composables/effects/useStickGuard'
import { toRenderItems, filterDisplayableMessages, renderKey } from '@/composables/logic/messageTurns'
import { isSubagentVirtualId, extractSubagentId, extractMainSessionId, useSubagentStore } from '@/stores/subagent'
import Turn from './message-stream/Turn.vue'
import SystemNotice from './message-stream/SystemNotice.vue'
import BgNotifyCard from './message-stream/BgNotifyCard.vue'
import BashOutputBlock from './message-stream/BashOutputBlock.vue'
import GuiComponentRenderer from './message-stream/GuiComponentRenderer.vue'
import TurnRail from './message-stream/TurnRail.vue'
import ForkNotice from './ForkNotice.vue'
import { extractGuiComponent } from '@/composables/logic/guiComponent'
import { useForkNoticeStream } from '@/composables/panel/useForkNoticeStream'
import { useLoadMoreHistory } from '@/composables/panel/useLoadMoreHistory'
import { useSessionActive } from '@/composables/panel/useSessionActive'
import { useMessageStreamScroll } from '@/composables/panel/useMessageStreamScroll'
import { useMessageStreamRail } from '@/composables/panel/useMessageStreamRail'
import { useStreamingPin } from '@/composables/panel/useStreamingPin'
import {
  useMessageStreamNotices,
  COMPACTING_NOTICE_HEIGHT,
  HANDOFF_NOTICE_HEIGHT,
} from '@/composables/panel/useMessageStreamNotices'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const chat = useChatStore()
const subagentStore = useSubagentStore()

/** W4 H4：加载更多历史 loading 状态 + handler（封装进 useLoadMoreHistory）。 */
const { loadingMore, showLoadMore, handleLoadMore } = useLoadMoreHistory(() => props.sessionId)

/** 当前 session 的消息（直接 Map.get 建立 Map 依赖，storeToRefs 等价；Map.set 触发更新）。 */
const currentMessages = computed(() => chat.messages.get(props.sessionId) ?? [])

/** subagent 虚拟 session running 时强制 streaming（JSONL 读出 status 恒 complete，但 subagent 可能还在跑）。 */
const forceWorking = computed(() => {
  if (!isSubagentVirtualId(props.sessionId)) return false
  return subagentStore.isRunning(extractMainSessionId(props.sessionId), extractSubagentId(props.sessionId))
})

/** session 级「对话进行中」信号（session-active-ssot T4）：驱动 Turn sticky/折叠 disabled/trace 展开等。
 *  ask-user（waiting）或 subagent 后台跑（working）都保持 true → 对话流不收起（M3 修复）。 */
const isSessionActive = useSessionActive(computed(() => props.sessionId), forceWorking)

/** 扁平消息 → 渲染项（turn + system 提示行穿插，纯函数）。
 *  filterDisplayableMessages 过滤 display:false 的 custom message（ADR-0035，读 display 字段非黑名单）。 */
const renderItems = computed(() =>
  toRenderItems(filterDisplayableMessages(currentMessages.value), forceWorking.value),
)

/** 渲染项里最后一个 turn（streaming 滚动判定 + hasWorkingTurn 派生用）。 */
const lastRenderTurn = computed(() => {
  for (let i = renderItems.value.length - 1; i >= 0; i -= 1) {
    const item = renderItems.value[i]
    if (item.kind === 'turn') return item.turn
  }
  return null
})

/** 虚拟滚动（W3）：窗口化渲染，视口外 turn 不挂载，长对话 DOM 从 O(N) 降到 O(可见)。
 *  items getter 返回完整 renderItems；高度缓存键用首消息 id（防 truncateFrom 张冠李戴）。
 *  像素常量（B2）强绑 DOM：直接参与 abs 定位 top，改 padding/字号/icon 必须同步，否则定位静默漂移
 *  （dev-only assertConstantHeights 实测对比并 warn）。COMPACTING/HANDOFF_HEIGHT 已下沉到 notices。 */
const ESTIMATED_TURN_HEIGHT = 200
/** 虚拟滚动上下 buffer turn 数（快速滚动时预渲染视口外的 turn，防白屏） */
const VIRTUAL_BUFFER_TURNS = 2
/** load-more 按钮预留高度（B2 强绑 DOM：Button h-8 + py-2 ≈ 48px，取 44 为历史值，避免定位回归）。 */
const LOAD_MORE_RESERVED_HEIGHT = 44

const virtualList = useVirtualTurnList({
  items: () => renderItems.value,
  scrollEl: () => scrollEl.value,
  estimatedHeight: () => ESTIMATED_TURN_HEIGHT,
  buffer: () => VIRTUAL_BUFFER_TURNS,
})
const { totalHeight, visibleRange, offsetOf, pinStreaming } = virtualList

/** load-more 顶部预留高度：显示且有 turns 时为 LOAD_MORE_RESERVED_HEIGHT，否则 0。
 *  turn abs top = offsetOf(idx) + topOffset，与 load-more（top=0）垂直不重叠（修 load-more 被遮挡 BLOCKER）。 */
const topOffset = computed(() =>
  showLoadMore.value && renderItems.value.length > 0 ? LOAD_MORE_RESERVED_HEIGHT : 0,
)

/** B2 dev-only 常量漂移检测：ResizeObserver 实测 vs 像素常量，不匹配 console.warn。生产裁剪零开销。 */
const [loadMoreEl, compactingNoticeEl] = useConstantHeightAssert([
  { name: 'LOAD_MORE_RESERVED_HEIGHT', expected: LOAD_MORE_RESERVED_HEIGHT },
  { name: 'COMPACTING_NOTICE_HEIGHT', expected: COMPACTING_NOTICE_HEIGHT },
]).els

/** 可见项 { idx, item, key } 数组（末项钉扎保证流式末项恒在窗口内）。预计算 key 避免 template :key 里调函数致 vue-tsc 误报 unused */
const visibleItems = computed(() => {
  const { startIndex, endIndex } = visibleRange.value
  const items = renderItems.value
  const arr: Array<{ idx: number; item: typeof items[number]; key: string }> = []
  for (let i = startIndex; i <= endIndex && i < items.length; i++) {
    arr.push({ idx: i, item: items[i], key: renderKey(items[i]) })
  }
  return arr
})

/** provide Turn 高度上报 registry（W2），Turn.vue inject 后用 ResizeObserver 上报自身高度 */
provideTurnResizeRegistry({
  reportHeight: (key, h) => virtualList.reportHeight(key, h),
})

/** 末尾瞬时块（compacting/handoff/dispatching）状态 + 垂直堆叠定位 + 取消 handler（M2 + fast-handoff）。
 *  内部委托 useNoticeStack 消除占位叠加重复计算（reviewer m4）。顺序：compacting → handoff → dispatching → fork 行。 */
const {
  isCompacting,
  isHandingOff,
  isDispatching,
  hasWorkingTurn,
  handoffNoticeTop,
  dispatchingTop,
  forkNoticeBaseTop,
  onAbortHandoff,
} = useMessageStreamNotices({
  sessionId: computed(() => props.sessionId),
  totalHeight,
  topOffset,
  hasWorkingTurn: () => lastRenderTurn.value?.isStreaming ?? false,
})

/** ForkNotice 反馈行（transient，RV1）：feed 消费 + 定位 + 交互封装在 useForkNoticeStream。
 *  [M2] 注入 forkNoticeBaseTop 消除占位叠加重复计算。 */
const { forkNotices, forkNoticeTop, onView: onForkNoticeView, onDismiss: onForkNoticeDismiss } =
  useForkNoticeStream(() => props.sessionId, {
    totalHeight,
    topOffset,
    isCompacting,
    isDispatching,
    hasWorkingTurn,
    compactNoticeHeight: COMPACTING_NOTICE_HEIGHT,
    isHandingOff,
    handoffNoticeHeight: HANDOFF_NOTICE_HEIGHT,
    injectedBaseTop: forkNoticeBaseTop,
  })

/** 最后一个含 user 的 turn 的数组下标（只有它的 user 可编辑，避免编辑中间 user 丢失其后对话） */
const lastUserTurnIdx = computed(() => {
  for (let i = renderItems.value.length - 1; i >= 0; i -= 1) {
    const item = renderItems.value[i]
    if (item.kind === 'turn' && item.turn.user) return i
  }
  return -1
})

/**
 * editing 钉扎（SR5，B9）：编辑中的 turn 滚出视口会卸载丢失 Turn.vue 的 draftText。
 *  据此钉住（editing=true）/释放（editing=false）该 turn 在窗口内。编辑只发生在 lastUserTurn。
 */
function onEditStateChange(idx: number, editing: boolean): void {
  virtualList.pinEditing(editing ? idx : -1)
}

/** streaming 钉扎（W3，对齐 editing 钉扎 SR5）：streaming turn 不能滚出视口顶（RO 会断开高度更新）。
 *  watch 最后一个 turn 的 isStreaming 驱动 pinStreaming，逻辑在 useStreamingPin。 */
useStreamingPin({ items: renderItems, pinStreaming, sessionId: () => props.sessionId })

/** auto-scroll stickToBottom guard：非贴底不强制拉回。showJumpButton 驱动「回到底部」浮层（= !stickToBottom）。
 *  contentEl 供 useChatScroll 的 ResizeObserver 观察异步渲染抖动。 */
const { scrollEl, contentEl, stickToBottom, showJumpButton, onScroll, scrollToBottom, pauseStickGuard, resumeStickGuard } = useChatScroll()
// session 切换 settling 窗口（详见 useSettlingGuard）：settling 期间 delta watch 跳过施加
const { settling, startSettling } = useSettlingGuard()

/* TurnRail（w4 wave IF4）：状态 + 事件路由下沉 useMessageStreamRail（script ≤300 行规范）。
   railTurns 派生自 renderItems；rail 内部调 useTurnExpansion（与 Turn.vue 各自 per-instance Map，w1 设计）。 */
const rail = useMessageStreamRail({
  sessionId: computed(() => props.sessionId),
  renderItems,
  scrollEl,
  offsetOf,
  topOffset,
})
const { railTurns, activeTurnIndex, panelRightEdge, expandedTurns, onJump, onToggle } = rail

/** provide stick guard pause/resume 给 Turn.vue（trace 折叠 transition 期间暂停 onScroll 误判）。 */
provideStickGuard({ pause: pauseStickGuard, resume: resumeStickGuard })

/** scroll 事件聚合 handler：onScroll 维护 stickToBottom；virtualList.onScrollUpdate 把 scrollTop/clientHeight
 *  同步进响应式 ref 驱动 visibleRange 重算（修 liveComputed 假 computed BLOCKER）；rail 更新 viewport indicator。 */
function handleScroll(): void {
  onScroll()
  virtualList.onScrollUpdate()
  rail.updateActiveTurnIndex()
}

/** scrollEl 挂载后同步一次 scrollTop/viewportHeight：visibleRange 是真 computed，初始 ref 均为 0，
 *  需读 DOM 真值才能让窗口基于真实视口定位（否则首渲染按 viewportHeight=0 算，仅末项钉扎撑场）。 */
watch(
  scrollEl,
  (el) => {
    if (el) virtualList.onScrollUpdate()
  },
  { immediate: true },
)

/** 滚动触发编排（消息/notice 变化 → scrollToBottom）：挂载滚到底、消息条数变化、流式 text 追加、
 *  notice 显隐四类触发，下沉到 useMessageStreamScroll。切换 session 的滚动留在下方（依赖 virtualList + settling）。 */
useMessageStreamScroll({
  currentMessages,
  lastRenderTurn,
  isCompacting,
  isHandingOff,
  isSessionActive,
  scrollToBottom,
})

// 切换 session → 重置虚拟列表高度缓存（不同 session 键语义不同，复用致错位 SR10/INVAR-8）+ 强制滚到底（展示最新）+ 开 settling
watch(
  () => props.sessionId,
  () => {
    virtualList.resetSession()
    scrollToBottom('auto', true)
    startSettling()
  },
)

// 视口锚定补偿（SR4/INVAR-2）：上方 turn 从估算切实测时 scrollTop 需补偿防跳。flush:'post'（W19）保证 delta 累积到位。
// [fix-scroll-jump] guard：贴底态跳过 delta（由 scrollToBottom 统一跟随到底），非贴底态正常补偿。
watch(
  () => virtualList.scrollAdjustDelta.value,
  (delta) => {
    if (delta !== 0 && scrollEl.value) {
      // FR1/FR2：stickToBottom=false（用户上滑）或 settling 期间跳过施加，仅清零（防陈旧 offset 拉偏）。
      // [fix-scroll-jump] 翻转 guard：贴底跳过、非贴底补偿。旧 guard (stickToBottom && !settling) 在负 delta（trace 收起）时与 scrollToBottom 冲突致跳变。
      if (!stickToBottom.value && !settling.value) {
        scrollEl.value.scrollTop += delta
      }
      // 清零防下次 reportHeight 残留值重复补偿（FR3 贴底原行为 + FR2 脱离丢弃）
      virtualList.scrollAdjustDelta.value = 0
    }
  },
  { flush: 'post' },
)
</script>

<style scoped>
/* message-stream 滚动条（draft） */
.message-stream::-webkit-scrollbar { width: 8px; }
.message-stream::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: 4px;
}
.message-stream::-webkit-scrollbar-thumb:hover { background: var(--neutral-dim); }

/* 回到底部浮层过渡 */
.fade-enter-active, .fade-leave-active { transition: opacity var(--duration-fast, 150ms) ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
