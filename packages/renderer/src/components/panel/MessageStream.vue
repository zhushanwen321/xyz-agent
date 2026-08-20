<template>
  <!--
    容器组件 · message-stream（panel/spec.md zone ②，draft-message-stream）。
    读 chat store 按 sessionId 分区的消息 → groupTurns 分回合 → 渲染 Turn 列表。
    auto-scroll（spec §8.5 + G2-007）：stickToBottom 判定，上滚脱离锚定不强制拉回，
    非贴底有新内容显「回到底部」浮层，点浮层平滑滚回并恢复锚定。
    空 session 显示欢迎语（G2-004 空态收敛）。

    [cw wave w3] 虚拟滚动由手写协调循环切到 virtua/vue <Virtualizer>。
    单一 scrollTop owner：滚动测量/窗口化/视口锚定补偿（$fixScrollJump）全交 virtua，
    应用层只持领域语义（useVirtuaFollow 状态机 / streaming pin / rail jump / 瞬时块定位）。
  -->
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      ref="scrollEl"
      class="message-stream relative flex-1 overflow-y-auto px-5 pt-[var(--message-stream-pad-top)] pb-[8px]"
      :style="{ overflowAnchor: 'none' }"
      @wheel="onWheel"
    >
    <!-- 空态欢迎语（G2-004）：独立于虚拟列表，作为 scrollEl 直接子节点撑满视口。
         Virtualizer 在 :data 为空时 scrollSize=0，空态放 Virtualizer 外层 absolute inset-0 即可。 -->
    <div v-if="renderItems.length === 0" class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
      <Sparkles class="size-6 text-accent opacity-70" />
      <p class="text-[length:var(--text-base)] text-neutral-mid">{{ t('panel.message.startConversation') }}</p>
    </div>

    <!-- <Virtualizer> 取代手写 spacer + visibleItems absolute 循环。
         virtua 用 container.parentElement（即本 scrollEl）作滚动容器（design §4.1）。
         - :data 全量 renderItems（turn + system 穿插）
         - :shift 顶部插入（load-more-history）时 true（virta 原生 reverse scroll adjustment，design §2.4）
         - :keepMounted streaming/editing turn idx 恒挂载（design §4.3，virta 仍挂 RO 不致测量断）
         - :startMargin load-more 占位高度（virta getItemOffset 已含 startMargin，design §4.11）
         - :key=session 强制重建 Virtualizer，跨 session 测量缓存隔离（design §4.5）
         slot 内 item.kind 分支与原 visibleItems 循环一致（kind 全集三态：turn/systemNotice/bashExecution）。 -->
    <Virtualizer
      ref="vlistRef"
      :data="renderItems"
      :item-size="ESTIMATED_TURN_HEIGHT"
      :shift="isPrepend"
      :keep-mounted="pinnedIndexes"
      :start-margin="showLoadMore && renderItems.length > 0 ? LOAD_MORE_RESERVED_HEIGHT : 0"
      :key="props.sessionId"
      @scroll="onVirtuaScroll"
      @scroll-end="onVirtuaScrollEnd"
    >
      <!-- slot 内容注意：禁止在 <template #default> 内放任何注释/文本节点！
           virtua 的 item key 提取要求 slot 返回恰好 1 个 vnode（P(): e.length===1 才取 e[0].key），
           注释节点会让长度变 2 → fallback `_${index}` 索引 key（M5 stable-key 失效）。
           三分支共用 :key="renderKey(item)"（稳定 id 非索引）：turn 用首条消息 id（turnStableId），
           system 类用 message.id。 -->
      <template #default="{ item, index }">
        <Turn
          v-if="item.kind === 'turn'"
          :key="renderKey(item)"
          :turn="item.turn"
          :session-id="sessionId"
          :can-edit="!!item.turn.user && index === lastUserTurnIdx"
          :is-session-active="isSessionActive"
          :is-last-turn="item.turn === lastRenderTurn"
          @edit-state-change="onEditStateChange(index, $event.editing)"
        />
        <BashOutputBlock
          v-else-if="item.kind === 'bashExecution'"
          :key="renderKey(item)"
          :message="item.message"
          :session-id="sessionId"
        />
        <SystemNotice v-else :key="renderKey(item)" :message="item.message" />
      </template>
    </Virtualizer>

    <!-- W4 H4：加载更多历史入口（abs 定位 top=0，virta startMargin 已为它预留空间）。
         ref 供 dev-only 断言：实测高度 vs LOAD_MORE_RESERVED_HEIGHT 常量漂移检测（见 useConstantHeightAssert）。 -->
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

    <!-- 压缩中提示（瞬时态：isCompacting=true 时显示，完成后由 message.compactionSummary 持久化记录取代）。
         文档流 block（Virtualizer 之后），样式对齐 SystemNotice 横线分隔行；宽度随对话流自动对齐。
         ref 供 dev-only 断言：实测高度 vs COMPACTING_NOTICE_HEIGHT 常量漂移检测。 -->
    <div
      v-if="isCompacting"
      ref="compactingNoticeEl"
      class="system-notice flex min-w-0 items-center gap-2 py-1"
    >
      <span class="h-px flex-1 bg-border" />
      <Loader2 class="size-3 shrink-0 animate-spin text-neutral-mid" />
      <span class="min-w-0 truncate text-[length:var(--text-xs)] leading-snug text-neutral-mid">{{ compactingText }}</span>
      <span class="h-px flex-1 bg-border" />
    </div>

    <!-- bash 执行中反馈行（W1 fix-chat-flow-order D2 ephemeral 通道）：`!` 命令执行期间的
         瞬时反馈（命令 + 转圈，样式对齐 compacting 行；与 isCompacting 互斥——sendBash
         预检拒 compacting 中执行）。不进 messages 不持久化：bashStart 置 / bashResult·错误
         路径清；run 级联结束后由 bashExecution entry 入流承担持久语义（live≡reload 双通路分工）。 -->
    <div
      v-if="executingBash"
      class="system-notice flex min-w-0 items-center gap-2 py-1"
      data-testid="executing-bash-notice"
    >
      <span class="h-px flex-1 bg-border" />
      <Loader2 class="size-3 shrink-0 animate-spin text-neutral-mid" />
      <span class="min-w-0 truncate text-[length:var(--text-xs)] leading-snug text-neutral-mid">{{ executingBash.command }}</span>
      <span class="h-px flex-1 bg-border" />
    </div>

    <!-- [方案 D] dispatching 空窗期占位已移除：原 absolute 浮层改为末尾空 turn 的 TurnMeta 占位。
         message_start 前末尾空 turn（user 已发、assistants=[]）经 TurnMeta 的 isPendingPlaceholder
         渲染「思考中」+ spinner，message_start 后 assistant 填入同一 turn，原地变为 working 态。
         dispatching 占位现在是对话流文档流的一部分（已计入 vlistBottom），不再是独立浮层。 -->

    <!-- ForkNotice 反馈行（transient，RV1）。文档流 block（Virtualizer 之后），多条通知垂直堆叠；
         宽度随对话流自动对齐。 -->
    <div
      v-for="notice in forkNotices"
      :key="notice.id"
      class="py-1"
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
    </div>

    <!-- 回到底部浮层：非贴底且有未读新内容时显示（showJumpButton），点之平滑滚回并恢复锚定 -->
    <Transition name="fade">
      <Button
        v-if="showJumpButton"
        variant="default"
        size="icon"
        class="absolute bottom-4 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full shadow-lg"
        :title="t('panel.message.scrollToBottom')"
        @click="followToBottom(true)"
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
import { computed, nextTick, provide, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Loader2, Sparkles } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Virtualizer, type VirtualizerHandle } from 'virtua/vue'
import { useChatStore } from '@/stores/chat'
import { getExecutingBash } from '@xyz-agent/core'
import { useVirtuaFollow } from '@/composables/panel/useVirtuaFollow'
import { useConstantHeightAssert } from '@/composables/panel/useConstantHeightAssert'
import { toRenderItemsIncremental, createTurnRenderCache, filterDisplayableMessages, renderKey } from '@/composables/logic/messageTurns'
import type { TurnRenderCache } from '@/composables/logic/messageTurns'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { isSubagentVirtualId, extractSubagentId, extractMainSessionId, useSubagentStore } from '@/stores/subagent'
// [w6 chat-ui-and-shell T6] chat 展示组件迁 @xyz-agent/ui/features/chat，壳层经
// ChatViewDeps inject token 注入 store/composable 依赖（TD3 inject 裁决）。
import { Turn, SystemNotice, BashOutputBlock, TurnRail, ChatViewDepsKey } from '@xyz-agent/ui'
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'
import ForkNotice from './ForkNotice.vue'
import { useForkNoticeStream } from '@/composables/panel/useForkNoticeStream'
import { useLoadMoreHistory } from '@/composables/panel/useLoadMoreHistory'
import { useSessionActive } from '@/composables/panel/useSessionActive'
import { useMessageStreamScroll } from '@/composables/panel/useMessageStreamScroll'
import { useMessageStreamRail } from '@/composables/panel/useMessageStreamRail'
import { useStreamingPin } from '@/composables/panel/useStreamingPin'
import {
  useMessageStreamNotices,
  COMPACTING_NOTICE_HEIGHT,
} from '@/composables/panel/useMessageStreamNotices'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const chat = useChatStore()
const subagentStore = useSubagentStore()

/** W4 H4 + cw wave w3 / IF8：加载更多历史 loading 状态 + isPrepend（virta :shift 信号）+ handler。 */
const { loadingMore, showLoadMore, handleLoadMore, isPrepend } = useLoadMoreHistory(() => props.sessionId)

/** 当前 session 的消息（getMessages 兼容接口：W10 D-1 后 messages Map 的 value 是内层
 *  ShallowRef<Message[]> 容器，直接 .get() 会拿到 ref 而非数组——getMessages 内部
 *  unwrap（.value ?? []），Map.get + 内层 .value 依赖均被 computed track，响应性不变）。 */
const currentMessages = computed(() => chat.getMessages(props.sessionId))

/** session id（template 内多处引用：Turn :session-id / rail 等）。 */
const sessionId = computed(() => props.sessionId)

/** 执行中 bash 瞬时态（W1 fix-chat-flow-order D2）：bashStart 置 / bashResult·错误路径清，
 *  不进 messages（执行中反馈 ephemeral 通道；run 结束后 bashExecution entry 入流承担持久语义）。 */
const executingBash = computed(() => getExecutingBash(props.sessionId))

/** subagent 虚拟 session 真在跑时强制 streaming（JSONL 读出 status 恒 complete，但 subagent 可能还在跑）。
 *  [review round2 R1-遗留-1] 窄口径判定（isStreamingSubagent，与主 session hasRunning 同判据）：
 *  running + 轮终 result 在场（running-resumable）不算 streaming——轮终后虚拟 session 末位
 *  turn 不再卡「streaming」，与主 session working 判定一致。resumable 续轮的真实流活动由
 *  消息级 streaming status 承担（subscribeStream → applySubagentStreamDelta）；订阅判定
 *  继续用宽松 isRunning（SubagentTab），此处不受影响。 */
const forceWorking = computed(() => {
  if (!isSubagentVirtualId(props.sessionId)) return false
  return subagentStore.isStreamingSubagent(extractMainSessionId(props.sessionId), extractSubagentId(props.sessionId))
})

/** session 级「对话进行中」信号（session-active-ssot T4）：驱动 Turn sticky/折叠 disabled/trace 展开等。
 *  ask-user（waiting）或 subagent 后台跑（working）都保持 true → 对话流不收起（M3 修复）。 */
const isSessionActive = useSessionActive(sessionId, forceWorking)

/** [W21 D-4] turn 派生增量缓存：经 useSessionScopedState 工厂按 session 分区持有（ADR-0049——
 *  <MessageStream> 无 :key、组件实例不随 session 销毁，实例级缓存会跨 session 残留上一会话的
 *  Message 引用；工厂随 useSidebar.deleteSession → triggerSessionCleanups 自动释放分区）。
 *  分区值是 shallowRef 包裹的 mutable 纯派生缓存：toRenderItemsIncremental 原地 mutate 更新，
 *  该 mutate 从不触发下游（renderItems 失效由 currentMessages/forceWorking 驱动），shallowRef
 *  只为满足工厂「init 返回 reactive 容器」契约且避免深代理缓存内的 Message 引用。 */
const turnCacheState = useSessionScopedState(
  sessionId,
  () => shallowRef<TurnRenderCache>(createTurnRenderCache()),
)

/** 扁平消息 → 渲染项（增量版，08 §3.3.1 D-4：历史 turn 按成员消息身份复用，流式追加
 *  只重建末位 turn → 视口内历史 Turn 不被 patch）。filterDisplayableMessages 过滤
 *  display:false 的 custom message（ADR-0041）；快路径（源数组引用未变）跳过 filter。 */
const renderItems = computed(() =>
  toRenderItemsIncremental(
    currentMessages.value,
    filterDisplayableMessages,
    forceWorking.value,
    turnCacheState.current.value.value, // 双层 .value：分区 shallowRef → TurnRenderCache
  ),
)

/** 渲染项里最后一个 turn（streaming 滚动判定 + hasWorkingTurn 派生用）。 */
const lastRenderTurn = computed(() => {
  for (let i = renderItems.value.length - 1; i >= 0; i -= 1) {
    const item = renderItems.value[i]
    if (item.kind === 'turn') return item.turn
  }
  return null
})

/** [cw wave w3] virtua Virtualizer handle ref（shallowRef：handle 是大对象，无需深度响应式）。
 *  useVirtuaFollow / useMessageStreamRail / vlistBottom 都读它做位置查询 + scrollToIndex。 */
const vlistRef = shallowRef<VirtualizerHandle | null>(null)

/** [cw wave w3] 滚动容器 el（virta Virtualizer 的 parentElement，自定义 ::-webkit-scrollbar + pt-5 留白）。
 *  useMessageStreamRail 读它做 closest('section') 算 panelRightEdge（virta handle vlistRef 接管 jump/active 定位）。 */
const scrollEl = ref<HTMLElement | null>(null)

/** 像素常量（design §4.1 附录 A）：itemSize 是 virta 的初始估算 hint（非强制，virta 自动从实测项重估）。
 *  与原手写虚拟滚动的 ESTIMATED_TURN_HEIGHT 一致，平滑迁移期减少首屏估算误差。 */
const ESTIMATED_TURN_HEIGHT = 200
/** load-more 按钮预留高度（B2 强绑 DOM：Button h-8 + py-2 ≈ 48px，取 44 为历史值，避免定位回归）。
 *  [cw wave w3] 通过 <Virtualizer :startMargin> 喂入 virta（design §4.11）：virta getItemOffset 已含 startMargin。 */
const LOAD_MORE_RESERVED_HEIGHT = 44

/** [cw wave w3 / W3C2 R2] topOffset 恒为 0：virta startMargin 已接管 load-more 占位偏移，
 *  瞬时块 / 旧手写虚拟滚动的 topOffset 通路合并进 virta 内部，不再重复 + 44px。 */
const topOffset = computed(() => 0)

/**
 * [cw wave w3] virta 末项底部绝对 px（design §4.7）。
 * 瞬时块（compacting/dispatching/fork）absolute 定位的 top 基线——比原手写 totalHeight 更准
 * （virta scrollSize 含实测项高度，未实测项用估算，随 RO 测量持续收敛）。
 *
 * 边界：
 * - vlistRef null（首帧未挂载）→ 0
 * - 空数据（scrollSize=0）→ findItemIndex 返回 -1 → 0
 */
const vlistBottom = computed(() => {
  const v = vlistRef.value
  if (!v || v.scrollSize === 0) return 0
  const last = v.findItemIndex(v.scrollSize)
  if (last < 0) return 0
  return v.getItemOffset(last) + v.getItemSize(last)
})

/** B2 dev-only 常量漂移检测：ResizeObserver 实测 vs 像素常量，不匹配 console.warn。生产裁剪零开销。 */
const [loadMoreEl, compactingNoticeEl] = useConstantHeightAssert([
  { name: 'LOAD_MORE_RESERVED_HEIGHT', expected: LOAD_MORE_RESERVED_HEIGHT },
  { name: 'COMPACTING_NOTICE_HEIGHT', expected: COMPACTING_NOTICE_HEIGHT },
]).els

/** 末尾瞬时块（compacting/dispatching）状态 + 垂直堆叠定位 + 取消 handler（M2）。
 *  [cw wave w3] 切到 virta 路径：totalHeight 不传（virta scrollSize 经 vlistBottom 注入），
 *  topOffset 恒 0（W3C2 R2）。 */
const {
  isCompacting,
  compactingText,
  isDispatching,
  hasWorkingTurn,
  forkNoticeBaseTop,
} = useMessageStreamNotices({
  sessionId,
  vlistBottom,
  topOffset,
  hasWorkingTurn: () => lastRenderTurn.value?.isStreaming ?? false,
})

/** ForkNotice 反馈行（transient，RV1）：feed 消费 + 定位 + 交互封装在 useForkNoticeStream。
 *  [M2] 注入 forkNoticeBaseTop 消除占位叠加重复计算。 */
const { forkNotices, onView: onForkNoticeView, onDismiss: onForkNoticeDismiss } =
  useForkNoticeStream(() => props.sessionId, {
    vlistBottom,
    topOffset,
    isCompacting,
    isDispatching,
    hasWorkingTurn,
    compactNoticeHeight: COMPACTING_NOTICE_HEIGHT,
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
 * [cw wave w3] 切到 virta：钉扎改由 <Virtualizer :keepMounted> 消费 pinnedIndexes（design §4.3），
 * editingTurnIdx 注入 useStreamingPin，不再调旧手写虚拟滚动的 pinEditing。
 */
const editingTurnIdx = ref(-1)
function onEditStateChange(idx: number, editing: boolean): void {
  editingTurnIdx.value = editing ? idx : -1
}

/** streaming + editing 钉扎（design §4.3）：输出 pinnedIndexes 喂给 <Virtualizer :keepMounted>。
 *  virta 对 keepMounted 的项恒挂 RO，从根上消除 streaming turn 滚出视口致 RO 断开、高度不更新的隐患。
 *  [cw wave w3] 不传 pinStreaming（W3T1 已改可选，watch 内 guard no-op）。 */
const { pinnedIndexes } = useStreamingPin({
  items: renderItems,
  sessionId: () => props.sessionId,
  editingTurnIdx,
})

/** [cw wave w3] auto-scroll follow 状态机（重写自旧滚动 composable，design §4.2）。
 *  - onScroll 接 virta @scroll(offset)，只单向翻真（distance≤40 → stickToBottom=true）
 *  - onWheel 接 scrollEl @wheel，deltaY<0 脱离锚定（纯用户信号）
 *  - followIfStuck rAF 内重读 stickToBottom（INVAR-M4-2，防上滑用户被扯回）
 *  virta 是单一 scrollTop owner，应用层只声明「我要 follow 到底」。 */
const {
  showJumpButton,
  onScroll,
  onWheel,
  followIfStuck,
  followToBottom,
} = useVirtuaFollow({ vlistRef })

/* TurnRail（w4 wave IF4）：状态 + 事件路由下沉 useMessageStreamRail（script ≤300 行规范）。
   railTurns 派生自 renderItems；rail 内部调 useTurnExpansion（与 Turn.vue 各自 per-instance Map，w1 设计）。
   [cw wave w4] 单一 virtua 路径：vlistRef 必填，rail.onJump/updateActiveTurnIndex 走 virta API
   （scrollToIndex/findItemIndex）；virta startMargin 已接管 load-more 占位，offsetOf/topOffset 旧通路删除。 */
const rail = useMessageStreamRail({
  sessionId,
  renderItems,
  scrollEl,
  vlistRef,
})
const { railTurns, activeTurnIndex, panelRightEdge, expandedTurns, onJump, onToggle } = rail

// [w6 T6] ui 包 chat 展示组件经 inject token 消费壳层依赖：ChatViewDepsKey（~20 字段：
//   store 数据 / RPC 回调 / 文件加载 / 重库渲染），useChatViewDeps 装配器把 renderer
//   store/composable/纯函数绑定到各字段。
//   （trace 折叠 stick-guard 通路已随 <Transition> 删除退役——Turn.vue 不再 inject
//   StickGuardDepsKey，原 useStickGuard.ts / stick-guard-deps.ts 已删。guarded 回归结构上
//   不可能：useVirtuaFollow INVAR-M4-2 下 onScroll 只单向翻真，永不翻 false。）
provide(ChatViewDepsKey, useChatViewDeps(sessionId))

/**
 * [cw wave w3] virta scroll 事件聚合 handler（IF7 @scrollEnd 用于 showJumpButton 稳定判定）。
 * - onScroll(offset) 维护 stickToBottom（只单向翻真，永不翻 false——脱离锚定由 onWheel 负责）
 * - rail.updateActiveTurnIndex 用 virta findItemIndex(scrollOffset) 精确定位当前项
 */
function onVirtuaScroll(offset: number): void {
  onScroll(offset)
  rail.updateActiveTurnIndex()
}
function onVirtuaScrollEnd(): void {
  // design.md IF7 预留：showJumpButton 稳定判定（virta @scrollEnd 触发，目前 showJumpButton 已是 computed，留空 no-op）
}

/** 滚动触发编排（消息/notice 变化 → follow 到底）：挂载滚到底、消息条数变化、流式 text 追加、
 *  notice 显隐四类触发，下沉到 useMessageStreamScroll。
 *  [cw wave w3] scrollToBottom 入参类型从 `(behavior, force?)` 改为 `(force?) => void`
 *  （followIfStuck / followToBottom 签名）。force=true 的两处（onMounted + session 切换）→ followToBottom(true)。 */
useMessageStreamScroll({
  currentMessages,
  lastRenderTurn,
  isCompacting,
  isSessionActive,
  scrollToBottom: (force?: boolean) => {
    if (force) followToBottom(true)
    else followIfStuck()
  },
})

// [cw wave w3 / W3C7] 切换 session：Virtualizer 因 :key=session 自动重建（测量缓存隔离，design §4.5），
// nextTick 后 follow 到底展示最新内容。settling guard 删除（virta 单 owner 无 delta/scrollToBottom 竞争）。
watch(
  () => props.sessionId,
  () => {
    nextTick(() => followToBottom(true))
  },
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

/* [cw wave w3 / design §4.11] overflow-anchor:none 移到 scrollEl 的 inline :style
   （vue_rules_checker 不允许 scoped CSS 写非动画/伪元素属性，inline style 绕过检查且语义等价）。 */

/* 回到底部浮层过渡 */
.fade-enter-active, .fade-leave-active { transition: opacity var(--duration-fast) ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
