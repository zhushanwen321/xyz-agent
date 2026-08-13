<template>
  <!--
    容器组件 · Panel（panel/spec.md zone 编排，承载一个 Session 的 body 区）。
    自上而下：② message-stream → ④ composer（companion 带，③ progress-zone 已删——
    state 恒 null 自隐藏死代码，见 conversation-renderer-model-unification §3.3.6）。
    ① panel-header 已提升到 PanelContainer（共享横跨 main+drawer 全宽，D2 一体化），
    本组件只承载 body。git 状态移入 SideDrawer git tab，入口在共享 header 右侧 git 按钮。
    section 透明继承 MainPanel 的统一 surface 外壳（border/radius/shadow 只在最外层 MainPanel），
    不再有独立 rounded-lg/border（避免在统一外壳内产生内圆角视觉）。
  -->
  <section
    class="relative flex min-w-0 h-full flex-col overflow-hidden"
    :style="panelStyle"
  >
    <!-- 渲染分支对齐 NewTaskFlow 状态机（修恢复空 session 的 chip 死锁）：
         - messageCount>0 → 对话流
         - new-task landing（无 session 或 flow.state==='landing'）→ Landing（chip 合法）
         - 已有空 session（有 sid 非 landing 态）→ 空对话态 + band composer（用户直输发该 session，不走 chip）
         - isSessionActive 优先不渲染 Landing（AC-2.8）。
         旧逻辑仅凭 messageCount===0 渲染 Landing，恢复空 session 时 flow.state=idle → chip transition
         非法（idle→dir-popover）抛错。对齐 flow 后 Landing 只在 landing 态渲染，空 session 走空对话态。 -->
    <!-- dead session 占位：进程已退出，不渲染对话流/composer，提供重开入口 -->
    <div
      v-if="isSessionDead"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <AlertCircle class="size-8 text-danger opacity-60" />
      <div class="space-y-1">
        <p v-if="restoreErrorCode === 'SESSION_NOT_FOUND'" class="text-sm text-text">{{ t('panel.panel.sessionFileLost') }}</p>
        <p v-else class="text-sm text-text">{{ t('panel.panel.sessionDead') }}</p>
        <p class="text-xs text-neutral-dim">{{ t('panel.panel.sessionDeadHint') }}</p>
      </div>
      <Button v-if="restoreErrorCode === 'SESSION_NOT_FOUND'" variant="ghost" size="sm" @click="onDeleteGhostSession">
        <Trash2 class="mr-1.5 size-3.5" />
        {{ t('panel.panel.deleteThisSession') }}
      </Button>
      <Button v-else variant="default" size="sm" @click="onReviveSession">
        <RotateCcw class="mr-1.5 size-3.5" />
        {{ t('panel.panel.reopen') }}
      </Button>
    </div>

    <MessageStream v-else-if="effectiveSessionId && effectiveMessageCount > 0" :session-id="effectiveSessionId" />
    <!-- overlay 态（subagent/agent call）但消息为空：agent call 历史文件只有 header（pi 延迟写入）或执行失败无输出 -->
    <div
      v-else-if="isViewingSubagent"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
    >
      <MessageSquare class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[12px] text-neutral-dim opacity-70">{{ t('panel.message.noAgentCall') }}</p>
    </div>
    <Landing
      v-else-if="!isSessionActive && isLandingView"
      :session-id="sessionId"
      :current-cwd="sessionDir || undefined"
      :git-branch="gitBranch"
      :history-error="historyError"
      @retry="onRetryHistory"
    />
    <div
      v-else-if="!isSessionActive && sessionId"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
    >
      <MessageSquare class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[12px] text-neutral-dim opacity-70">{{ t('panel.panel.startConversation') }}</p>
    </div>
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <MessageSquare class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[12px] text-neutral-dim opacity-70">{{ t('panel.panel.selectSession') }}</p>
    </div>

    <!-- ④ composer companion zone（③ progress-zone 已删——真实任务态未接入，state 恒 null
         自隐藏死代码）。git 状态已移入 SideDrawer git tab（原 zone ⑤ 摘牌），此带仅 composer。
         ask-user 富交互（W2）：请求到达时 AskUserOverlay 覆盖 composer 位置（互斥），
         对话历史全程可见，composer 消失输入禁止（不再走全屏 modal）。 -->
    <div v-if="!isViewingSubagent" class="composer-band flex flex-shrink-0 flex-col gap-1.5 px-5 pb-3.5">
      <!-- ④ composer（FG5，S1/S2/S5/S6 主路径）/ ask-user overlay（互斥）。
           new-task landing 态由 Landing 内部渲染 composer 卡片，此处 band 不重复渲染
           （showPanelComposer：非 landing 才挂）。已绑空 session（恢复的僵尸空 session）
           走空对话态，band 渲染 composer 供用户直输发该 session。
           ask-user 请求到达时 AskUserOverlay 接管 band，composer 隐藏（互斥，W2）。 -->
      <AskUserOverlay
        v-if="hasAskUserRequest"
        :questions="askUserQuestions"
        :allow-cancel="currentAskUserRequest?.allowCancel"
        :started-at="askUserStartedAt"
        @submit="onAskUserSubmit"
        @cancel="onAskUserCancel"
      />
      <Composer v-else-if="showPanelComposer" :session-id="sessionId" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessageSquare, AlertCircle, RotateCcw, Trash2 } from '@lucide/vue'
import { isAskUserQuestion, type AskUserQuestion } from '@xyz-agent/extension-protocol'
import MessageStream from './MessageStream.vue'
import Composer from './Composer.vue'
import { Button } from '@/components/ui/button'
import Landing from '@/components/new-task/Landing.vue'
import AskUserOverlay from '@/components/extension/ask-user/AskUserOverlay.vue'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useSidebarNew } from '@/composables/features/sidebar/useSidebarNew'
import { useToast } from '@/composables/useToast'
import { useExtensionUI, askUserFilter } from '@/composables/useExtensionUI'

const props = defineProps<{
  panelId: string
  sessionId: string | null
  /** 工作目录（Landing current-cwd 用） */
  sessionDir: string
  /** git 分支名（Landing 用） */
  gitBranch?: string
}>()

const { t } = useI18n()
const chat = useChatStore()
const sessionStore = useSessionStore()
const { error: toastError } = useToast()
const subagentStore = useSubagentStore()
const workflowStore = useWorkflowStore()

const flow = useNewTaskFlow()

/** dead session 重开：显式调 useSidebarNew.restoreSession（setup 内解构，避免事件回调调 composable 触发 useI18n 报错） */
const { restoreSession, retryHistory, deleteSession } = useSidebarNew()

/** restore 失败的错误 code（ghost session 判据）：SESSION_NOT_FOUND 时显示删除入口 */
const restoreErrorCode = ref<string | null>(null)

/** Panel 卸载时停止 subagent streaming 订阅（防止泄漏）。
 *  subagent overlay 的 header 展示与返回逻辑已随 PanelHeader 提升到 PanelContainer，
 *  本组件只保留 streaming 订阅的生命周期清理（订阅跟随 panel 内容）。 */
onUnmounted(() => {
  subagentStore.stopStream(props.panelId)
})

/**
 * overlay 模式：viewing subagent 或 agent call 时用虚拟 session ID 渲染 MessageStream，
 * 否则用主 session ID。panel store 的 sessionId 从不被替换（主 session 保持高亮、文件视图不变）。
 * subagent overlay 优先于 agent call overlay（两者互斥，不会同时 active）。
 */
const effectiveSessionId = computed(
  () => subagentStore.getActiveSubagentVirtualId(props.panelId, props.sessionId)
    ?? workflowStore.getActiveAgentCallVirtualId(props.panelId)
    ?? props.sessionId,
)

/** 本 panel 是否正在查看 overlay（subagent 或 agent call）。
 *  驱动 body 渲染分支（overlay 空消息占位）。header 展示逻辑已提升到 PanelContainer。 */
const isViewingSubagent = computed(
  () => subagentStore.isViewing(props.panelId) || workflowStore.isViewing(props.panelId),
)

/** subagent overlay 时的消息数（虚拟 session 的消息数） */
const effectiveMessageCount = computed(() =>
  effectiveSessionId.value ? chat.getMessages(effectiveSessionId.value).length : 0,
)

// W1 useExtensionUI per-sessionId 订阅：本 Panel 绑定的 session 的 UI 请求队列。
// B1 防重复入队：Panel 只收 askUser 请求（非 askUser 由 CompanionBand 处理）
// landing 态 sessionId=null 时内部 null 守卫已处理，不订阅。
const { currentAskUserRequest, respond: respondExtensionUI, cancel: cancelExtensionUI } =
  useExtensionUI(computed(() => props.sessionId), askUserFilter)

/** 当前 session 是否已 dead（进程退出）。dead 态显示占位 UI + 重开入口，不渲染对话流/composer */
const isSessionDead = computed(() => {
  if (!props.sessionId) return false
  const s = sessionStore.list.find((item) => item.id === props.sessionId)
  return s?.status === 'dead'
})

/** 生成态优先：本 Panel 的 session 正在流式时不渲染 landing（AC-2.8）。
 *  [HISTORICAL] 原用全局 chat.isGenerating，A 会话流式时点新建切到空 session（sessionId=null），
 *  空 session 的 Landing 被 !isGenerating 守卫误伤 → 落到分支兜底空态（「选择左侧会话开始」），
 *  new-task 渲染撕裂。改为 per-session：只有本 Panel 绑定的 session 在流式才算 active。
 *  landing 态 sessionId=null → streamingSessionId 恒不等 → isSessionActive=false → Landing 正常渲染。
 *  [W1] isActive 作为 UI 层 SSOT：消除提交后到 message_start 之间空窗期的状态不一致。 */
const isSessionActive = computed(
  () => !!props.sessionId && chat.isActive(props.sessionId),
)
/** new-task landing 视图判据：完全无 session（首次启动/点新建）或 NewTaskFlow 处于 landing 态。
 *  Landing 的 directory/branch chip 仅在 flow.state==='landing' 时点击合法，故 Landing 只在此态渲染；
 *  恢复空 session（有 sid 无消息 但 flow.state=idle）不走 landing，避免 chip transition 非法死锁。 */
const isLandingView = computed(
  () => !props.sessionId || flow.state.value === 'landing',
)
/** 当前 session 是否处于 compact 互斥态（#6：session.compacting 驱动，按 session 隔离）。
 *  compact 是独立互斥态：不并入 isActive（用户不可干预压缩流程），但视觉态属 running
 *  （圆点呼吸），且 compact 期需继续渲染 Composer 显示压缩进度，故 showPanelComposer 单列分支。 */
const isCompacting = computed(
  () => !!props.sessionId && chat.isCompacting(props.sessionId),
)
/** band 内 Composer 渲染：new-task landing 态由 Landing 内嵌 composer 卡片承接，band 不重复渲染；
 *  已绑 session（含恢复的空 session，非 landing 态）→ band 渲染 composer 供直输；生成态始终挂；
 *  compact 期也挂（显示压缩态，composer 内部按 isCompacting 切禁用/进度）。 */
const showPanelComposer = computed(
  () =>
    (!!props.sessionId && !isLandingView.value && !isSessionDead.value) ||
    isSessionActive.value ||
    isCompacting.value,
)
/** W2 ask-user inline：有 ask-user 请求时 AskUserOverlay 接管 band（与 Composer 互斥）。
 *  hasAskUserRequest 优先级高于 showPanelComposer——ask-user 是阻塞输入请求，必须承接。
 *  W6: dead session 态不渲染——进程已退出，用户点击 Submit 会发给已死的 session。 */
const hasAskUserRequest = computed(() =>
  currentAskUserRequest.value !== undefined && !isSessionDead.value,
)
/** ask-user questions（类型守卫收窄 unknown[] → AskUserQuestion[]）。
 *  askUserQuestions 字段由 runtime event-adapter 从 select 通道透传，
 *  用 isAskUserQuestion 守卫过滤掉结构异常的元素，避免渲染 undefined。 */
const askUserQuestions = computed<AskUserQuestion[]>(() => {
  const req = currentAskUserRequest.value
  if (!req?.askUser || !req.askUserQuestions) return []
  return req.askUserQuestions.filter(isAskUserQuestion)
})
/** 倒计时起点：请求入队时刻（useExtensionUI push 时打 receivedAt 戳）。
 *  用入队时刻而非渲染时刻——Panel 可能在请求已挂起后才 mount（切 panel/视图切回），
 *  此时渲染时刻 ≠ 请求到达时刻，用 Date.now() 会导致倒计时重置、与 runtime 5min 超时不同步。 */
const askUserStartedAt = computed(() =>
  currentAskUserRequest.value?.receivedAt ?? Date.now(),
)
/** ask-user Submit：answers JSON string 回传给 pi（select method）。 */
function onAskUserSubmit(answers: string): void {
  const req = currentAskUserRequest.value
  if (!req) return
  respondExtensionUI(req.requestId, answers)
}
/** ask-user Cancel：等价 respond(requestId, null)。 */
function onAskUserCancel(): void {
  const req = currentAskUserRequest.value
  if (!req) return
  cancelExtensionUI(req.requestId)
}
/** getHistory 失败态（landing 重试出口，AC-2.6） */
const historyError = computed(() =>
  props.sessionId ? chat.failedHistory.has(props.sessionId) : false,
)

/** Landing 重试 → useSidebarNew.retryHistory（#2 AC-2.6） */
function onRetryHistory(): void {
  if (props.sessionId) void retryHistory(props.sessionId)
}

/** dead session「重新打开」：调 useSidebarNew.restoreSession（显式 restore RPC），成功后内部已 revive */
async function onReviveSession(): Promise<void> {
  if (!props.sessionId) return
  restoreErrorCode.value = null
  try {
    await restoreSession(props.sessionId)
  } catch (e) {
    const code = (e as Error & { code?: string }).code
    restoreErrorCode.value = code ?? null
    const msg = e instanceof Error ? e.message : String(e)
    toastError(t('panel.panel.reopenFailed', { error: msg }))
  }
}

/** ghost session 删除：session 文件丢失（SESSION_NOT_FOUND）后用户选择删除该项 */
async function onDeleteGhostSession(): Promise<void> {
  if (!props.sessionId) return
  try {
    await deleteSession(props.sessionId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toastError(msg)
  }
}

/**
 * Panel 底色 + --panel-bg CSS 变量（供子组件如 sticky turn-meta 消费，保证浮层底色与所在 panel 一致）。
 * section 透明继承 MainPanel 的 bg-surface，--panel-bg=surface 供子组件浮层对齐。
 * header 已提升到 PanelContainer，本组件仅 body 区，无边框/圆角（融入统一外壳）。
 */
const panelStyle = computed(() => ({ '--panel-bg': 'var(--surface)' }))
</script>
