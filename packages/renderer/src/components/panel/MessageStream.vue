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
      <p class="text-[13px] text-muted">{{ t('panel.message.startConversation') }}</p>
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
            @edit-state-change="onEditStateChange(vi.idx, $event.editing)"
          />
          <BgNotifyCard v-else-if="vi.item.message.bgNotify" :message="vi.item.message" />
          <!-- 结构化 GUI 组件（extension GUI 协议 E5：customMessage 的 details.__gui__）。 -->
          <div
            v-else-if="getGuiComponent(vi.item.message)"
            class="py-1 pl-1 font-mono text-[12px] leading-snug text-fg"
          >
            <GuiComponentRenderer :component="getGuiComponent(vi.item.message)!" />
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
        class="system-notice absolute left-5 right-5 flex min-w-0 items-center gap-2 py-1"
        :style="{ top: totalHeight + topOffset + 'px' }"
      >
        <span class="h-px flex-1 bg-border" />
        <Loader2 class="size-3 shrink-0 animate-spin text-muted" />
        <span class="min-w-0 truncate text-[11px] leading-snug text-muted">{{ t('panel.message.compressing') }}</span>
        <span class="h-px flex-1 bg-border" />
      </div>

      <!-- dispatching 空窗期占位（非虚拟化，absolute 定位到列表末尾 + topOffset） -->
      <div
        v-if="isDispatching && !hasWorkingTurn"
        class="absolute left-5 right-5 flex items-center gap-2 py-2 pl-1 text-[12px] text-muted"
        :style="{ top: (isCompacting ? totalHeight + COMPACTING_NOTICE_HEIGHT : totalHeight) + topOffset + 'px' }"
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Loader2, Sparkles } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chat'
import { useChatScroll } from '@/composables/effects/useChatScroll'
import { useVirtualTurnList } from '@/composables/effects/useVirtualTurnList'
import { useConstantHeightAssert } from '@/composables/effects/useConstantHeightAssert'
import { provideTurnResizeRegistry } from '@/composables/effects/useResizeReport'
import { toRenderItems, filterDisplayableMessages, renderKey } from '@/composables/logic/messageTurns'
import { isSubagentVirtualId, extractSubagentId, useSubagentStore } from '@/stores/subagent'
import Turn from './message-stream/Turn.vue'
import SystemNotice from './message-stream/SystemNotice.vue'
import BgNotifyCard from './message-stream/BgNotifyCard.vue'
import GuiComponentRenderer from './message-stream/GuiComponentRenderer.vue'
import ForkNotice from './ForkNotice.vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { extractGui } from '@xyz-agent/extension-protocol'
import { type Message } from '@xyz-agent/shared'
import { useForkNoticeStream } from '@/composables/panel/useForkNoticeStream'
import { useLoadMoreHistory } from '@/composables/panel/useLoadMoreHistory'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const chat = useChatStore()
const subagentStore = useSubagentStore()

/** W4 H4：加载更多历史 loading 状态 + handler（封装进 useLoadMoreHistory） */
const { loadingMore, showLoadMore, handleLoadMore } = useLoadMoreHistory(() => props.sessionId)

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

/** 扁平消息 → 渲染项（turn + system 提示行穿插，纯函数）。
 *  先用 filterDisplayableMessages 过滤 display:false 的 custom message（ADR-0035，读 pi CustomMessage.display
 *  字段非黑名单），再转渲染项。 */
const renderItems = computed(() =>
  toRenderItems(filterDisplayableMessages(currentMessages.value), forceWorking.value),
)

/**
 * 虚拟滚动（W3）：窗口化渲染，视口外 turn 不挂载，长对话 DOM 从 O(N) 降到 O(视口可见)。
 * items getter 返回完整 renderItems（含 turn + system），composable 内部统一处理。
 * 高度缓存键用首消息 id（turn）/ s-message.id（system），非 t-index（防 truncateFrom 张冠李戴）。
 * 前置依赖 M4（scrollToBottom rAF trailing 节流 + INVAR-M4-2 延迟求值守卫）已落地。
 */
/**
 * ── 像素常量与 DOM 强绑定（B2）──────────────────────────────────────────
 * 下面三个高度常量直接参与 absolute 定位 top 计算，依赖模板对应 DOM 块的真实高度。
 * 改任何一方的 padding/字号/icon size 都必须同步另一方，否则定位会静默漂移。
 * dev-only assertConstantHeights（见下方）会实测对比并在不匹配时 console.warn。
 */
/**
 * 虚拟滚动估算高度（未实测 turn 的初始高度，经验值）。
 * 与定位无关——只在 ResizeObserver 上报实测值之前作 fallback，上报后即被替换。
 */
const ESTIMATED_TURN_HEIGHT = 200
/** 虚拟滚动上下 buffer turn 数（快速滚动时预渲染视口外的 turn，防白屏） */
const VIRTUAL_BUFFER_TURNS = 2
/**
 * load-more 按钮预留高度。
 * 强绑定 DOM：模板 load-more 块（abs top=0，`flex justify-center py-2` 内含 `Button size="sm"`）。
 *   实际高度 = Button(h-8=32px) + py-2(8px*2=16px) ≈ 48px；常量取 44 是历史值（略偏小，
 *   topOffset 给 turn 留的避让空间略紧但未致遮挡，保持现状避免引入定位回归）。
 *   若改 Button size / py-* / icon size，必须重测并同步此常量（dev 断言会提醒）。
 */
const LOAD_MORE_RESERVED_HEIGHT = 44
/**
 * compaction notice 占位高度。
 * 强绑定 DOM：模板 isCompacting 块（`flex items-center gap-2 py-1`，含 `size-3` spinner
 *   + `text-[11px] leading-snug` 文本 + 两条 `h-px` 分隔线）。
 *   实际高度 ≈ py-1(4px*2) + max(spinner 12px, text≈16px) ≈ 24px；常量 28 略大，给 dispatching
 *   占位避让留 4px 余量。改 padding/字号/icon 必须重测并同步此常量（dev 断言会提醒）。
 */
const COMPACTING_NOTICE_HEIGHT = 28

const virtualList = useVirtualTurnList({
  items: () => renderItems.value,
  scrollEl: () => scrollEl.value,
  estimatedHeight: () => ESTIMATED_TURN_HEIGHT,
  buffer: () => VIRTUAL_BUFFER_TURNS,
})
const { totalHeight, visibleRange, offsetOf } = virtualList

/**
 * load-more 按钮占的顶部预留高度：显示 load-more 且有 turns 时为 LOAD_MORE_RESERVED_HEIGHT，
 * 否则 0。所有 turn 的 abs 定位 top = offsetOf(idx) + topOffset，load-more 按钮 abs 定位 top=0，
 * 两者在垂直方向不重叠（修复 load-more 被首条 turn 遮挡的 BLOCKER）。
 */
const topOffset = computed(() =>
  showLoadMore.value && renderItems.value.length > 0 ? LOAD_MORE_RESERVED_HEIGHT : 0,
)

/**
 * B2 dev-only 常量高度漂移检测：绑定对应 DOM 块，ResizeObserver 实测高度 vs 像素常量，
 * 不匹配时 console.warn（提示 padding/字号/icon 改动未同步常量）。生产构建被 import.meta.env.DEV
 * 守卫裁剪，零运行时开销。逻辑封装在 useConstantHeightAssert，此处只注册常量并取回 ref 绑模板。
 */
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

/**
 * ForkNotice 反馈行（transient，RV1）：feed 消费 + 定位 + 交互已封装进 useForkNoticeStream。
 * bindForkNoticeEffect（App.vue）订阅 session.forkNotice 广播并按 srcSessionId 路由入 feed，
 * 本 composable 读自身 session 的通知并在对话流末尾定位渲染。不进 chat store（transient）。
 * 定位依赖以 ComputedRef 注入（totalHeight/topOffset/isCompacting 等，容器侧计算结果）。
 */
const { forkNotices, forkNoticeTop, onView: onForkNoticeView, onDismiss: onForkNoticeDismiss } =
  useForkNoticeStream(() => props.sessionId, {
    totalHeight,
    topOffset,
    isCompacting,
    isDispatching,
    hasWorkingTurn,
    compactNoticeHeight: COMPACTING_NOTICE_HEIGHT,
  })

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

/**
 * editing 钉扎（SR5，B9）：编辑中的 turn 滚出视口会卸载丢失 Turn.vue 的 draftText。
 * Turn.vue watch isEditingThisUser 变化时 emit edit-state-change，据此钉住（editing=true）
 * 或释放（editing=false）该 turn 在窗口内。编辑只发生在 lastUserTurn，idx 即其数组下标。
 */
function onEditStateChange(idx: number, editing: boolean): void {
  virtualList.pinEditing(editing ? idx : -1)
}

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
const { scrollEl, contentEl, stickToBottom, showJumpButton, onScroll, scrollToBottom } = useChatScroll()

/**
 * scroll 事件聚合 handler：useChatScroll.onScroll 维护 stickToBottom（贴底判定），
 * virtualList.onScrollUpdate 把 DOM scrollTop/clientHeight 同步进响应式 ref 驱动
 * visibleRange 失效重算（纯滚动场景下窗口跟随收敛，修复 liveComputed 假 computed 的 BLOCKER）。
 */
function handleScroll(): void {
  onScroll()
  virtualList.onScrollUpdate()
}

/**
 * scrollEl 挂载后立即同步一次 scrollTop/viewportHeight：virtualList 的 visibleRange 是
 * 真 computed，初始 scrollTop/viewportHeight ref 均为 0，需读 DOM 真值写入 ref 才能让
 * 窗口基于真实视口定位（否则首次渲染窗口按 viewportHeight=0 算，仅末项钉扎撑场）。
 */
watch(
  scrollEl,
  (el) => {
    if (el) virtualList.onScrollUpdate()
  },
  { immediate: true },
)

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

// 切换 session → 重置虚拟列表高度缓存（不同 session 键语义不同，复用致错位，SR10/INVAR-8）
//   + 强制滚到底（展示最新内容，不受 guard）
watch(
  () => props.sessionId,
  () => {
    virtualList.resetSession()
    scrollToBottom('auto', true)
  },
)

// 视口锚定补偿（SR4/INVAR-2）：视口上方 turn 从估算切实测时 scrollTop 需补偿，防用户所见内容跳。
// reportHeight 累积 delta（同帧多次视口上方 turn 上报累加防末次覆盖中间值），此处应用后清零防重复补偿。
// W19: flush:'post'——DOM 更新后再应用 delta。pre 模式下 watch 与下次 flushHeightReports
// 可能同帧执行：watch 应用并清零后，同一 tick 内又累积的 delta 会在清零时被抹除（中间 delta 丢失）。
// post 模式保证 watch 在 DOM flush 后触发，此时 reportHeight 的 rAF flush 已结束，本帧 delta 全部累积到位。
//
// [fix-scroll-jump-during-streaming] 用户主动滚动 guard：补偿只应稳定「程序性滚动后的视口」。
// stickToBottom=false（用户已 wheel 上滑脱离锚定）时视口位置由用户掌控，历史 delta 已无意义——
// 跳过施加但仍清零（FR1 不施加 + FR2 丢弃不延后，防回到底部瞬间被陈旧 offset 拉偏）。
// stickToBottom 读 watch 回调内的当前值（非调用时捕获），保证用户当帧 wheel 后当帧即跳过（FR5）。
watch(
  () => virtualList.scrollAdjustDelta.value,
  (delta) => {
    if (delta !== 0 && scrollEl.value) {
      // FR1/FR2：用户主动滚动期间（stickToBottom=false）跳过施加，仅清零丢弃，不延后到回到底部
      if (stickToBottom.value) {
        scrollEl.value.scrollTop += delta
      }
      // 清零，防下次 reportHeight 残留值导致重复补偿（两个分支都清零——FR3 贴底原行为 + FR2 脱离丢弃）
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
.message-stream::-webkit-scrollbar-thumb:hover { background: var(--subtle); }

/* 回到底部浮层过渡 */
.fade-enter-active, .fade-leave-active { transition: opacity var(--duration-fast, 150ms) ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
