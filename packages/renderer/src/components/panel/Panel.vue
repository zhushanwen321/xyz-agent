<template>
  <!--
    容器组件 · Panel（panel/spec.md 5 zone 编排，承载一个 Session）。
    自上而下：① panel-header → ② message-stream → ③ progress-zone → ④ composer（companion 带）。
    git 状态移入 SideDrawer git tab（原底部 zone ⑤ 摘牌，panel/spec.md），入口为 header 右侧 git 按钮。
    激活标识（workspace/spec.md）：rounded-lg + ring-1 accent + bg-elevated 浮起；非激活 opacity 0.5。
    点击 panel body 切 active（主从焦点，非按钮区域）。
    [HISTORICAL] 原「左 2px 竖条 + inset box-shadow ring」双叠加导致激活 panel 左边 3px、其余边 1px，
    边框厚度不均；inset shadow 在直角 section 上不跟随外层 MainPanel 圆角，圆角处露 bg。
    改 ring-1（box-shadow 外发光，跟随 rounded-lg）+ 去竖条，4 边均匀且圆角覆盖。
  -->
  <section
    class="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg transition-[background-color,opacity,box-shadow] duration-[var(--duration)] ease-[var(--ease)]"
    :class="panelStateClass"
    :style="panelStyle"
    @mousedown="onPanelMouseDown"
  >
    <PanelHeader
      :session-label="sessionLabel"
      :session-dir="sessionDir"
      :git-branch="gitBranch"
      :git-indicator="gitIndicator"
      :status="status"
      :active="active"
      :is-dual="isDual"
      :is-first-panel="isFirstPanel"
      @split="emit('split')"
      @new-session="emit('new-session')"
      @close="emit('close')"
      @open-git="emit('openGit')"
    />

    <!-- 渲染分支对齐 NewTaskFlow 状态机（修恢复空 session 的 chip 死锁）：
         - messageCount>0 → 对话流
         - new-task landing（无 session 或 flow.state==='landing'）→ Landing（chip 合法）
         - 已有空 session（有 sid 非 landing 态）→ 空对话态 + band composer（用户直输发该 session，不走 chip）
         - isGenerating 优先不渲染 Landing（AC-2.8）。
         旧逻辑仅凭 messageCount===0 渲染 Landing，恢复空 session 时 flow.state=idle → chip transition
         非法（idle→dir-popover）抛错。对齐 flow 后 Landing 只在 landing 态渲染，空 session 走空对话态。 -->
    <!-- dead session 占位：进程已退出，不渲染对话流/composer，提供重开入口 -->
    <div
      v-if="isSessionDead"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <AlertCircle class="size-8 text-danger opacity-60" />
      <div class="space-y-1">
        <p class="text-sm text-text">会话进程已退出</p>
        <p class="text-xs text-subtle">进程异常终止，对话不可继续。可尝试重新打开。</p>
      </div>
      <Button variant="default" size="sm" @click="onReviveSession">
        <RotateCcw class="mr-1.5 size-3.5" />
        重新打开
      </Button>
    </div>

    <MessageStream v-else-if="sessionId && messageCount > 0" :session-id="sessionId" />
    <Landing
      v-else-if="!isGenerating && isLandingView"
      :session-id="sessionId"
      :current-cwd="sessionDir || undefined"
      :git-branch="gitBranch"
      :history-error="historyError"
      @retry="onRetryHistory"
    />
    <div
      v-else-if="!isGenerating && sessionId"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
    >
      <MessageSquare class="size-6 text-subtle opacity-40" />
      <p class="text-[12px] text-subtle opacity-70">输入消息开始对话</p>
    </div>
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
      <MessageSquare class="size-6 text-subtle opacity-40" />
      <p class="text-[12px] text-subtle opacity-70">选择左侧会话开始</p>
    </div>

    <!-- ③④ companion zones：progress / composer 垂直 6px 紧凑成「带」。
         git 状态已移入 SideDrawer git tab（原 zone ⑤ 摘牌），此带仅 progress/composer。 -->
    <div class="composer-band flex flex-shrink-0 flex-col gap-1.5">
      <!-- ③ progress-zone（composer 上方）：真实任务态未就绪时不渲染（组件内 v-if="state" 自隐藏） -->
      <ProgressZone />

      <!-- ④ composer（FG5，S1/S2/S5/S6 主路径）。new-task landing 态由 Landing 内部渲染 composer
           卡片，此处 band 不重复渲染（showPanelComposer：非 landing 才挂）。已绑空 session
           （恢复的僵尸空 session）走空对话态，band 渲染 composer 供用户直输发该 session。 -->
      <Composer v-if="showPanelComposer" :session-id="sessionId" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { MessageSquare, AlertCircle, RotateCcw } from '@lucide/vue'
import type { DerivedStatus } from '@/types'
import type { GitIndicator } from '@/composables/features/useGitStatus'
import PanelHeader from './PanelHeader.vue'
import ProgressZone from './ProgressZone.vue'
import MessageStream from './MessageStream.vue'
import Composer from './Composer.vue'
import Landing from '@/components/new-task/Landing.vue'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/useSidebar'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  panelId: string
  sessionId: string | null
  sessionLabel: string
  sessionDir: string
  gitBranch?: string
  /** git 脏状态指示（PanelContainer 统一提供，透传给 PanelHeader；hasRepo=false 不渲染 git 按钮） */
  gitIndicator?: GitIndicator
  status: DerivedStatus
  active: boolean
  isDual: boolean
  /** 是否为 P1（panel.panels[0]，DFS 顺序即 split 的 left）—— 折叠态 chrome 仅 P1 落 header */
  isFirstPanel: boolean
}>()

const emit = defineEmits<{
  activate: [panelId: string]
  split: []
  'new-session': []
  close: []
  /** 打开 SideDrawer git tab（PanelContainer 统一渲染抽屉，事件上抛） */
  openGit: []
}>()

/** 点击 panel body 切 active（双 panel 主从焦点）；点 header 按钮不误切（按钮自身 stopPropagation） */
function onPanelMouseDown(e: MouseEvent): void {
  if (!props.isDual || props.active) return
  // 按钮点击由 reka-ui/Button 内部处理，这里检查最近 button 祖先避免误切
  if ((e.target as HTMLElement).closest('button')) return
  emit('activate', props.panelId)
}

const chat = useChatStore()
const sessionStore = useSessionStore()
const { error: toastError } = useToast()

const flow = useNewTaskFlow()

/** 当前 session 是否已 dead（进程退出）。dead 态显示占位 UI + 重开入口，不渲染对话流/composer */
const isSessionDead = computed(() => {
  if (!props.sessionId) return false
  const s = sessionStore.list.find((item) => item.id === props.sessionId)
  return s?.status === 'dead'
})

/** 当前 session 消息数（未 hydrate / 无 session → 0） */
const messageCount = computed(() =>
  props.sessionId ? chat.getMessages(props.sessionId).length : 0,
)
/** 生成态优先：本 Panel 的 session 正在流式时不渲染 landing（AC-2.8）。
 *  [HISTORICAL] 原用全局 chat.isGenerating，A 会话流式时点新建切到空 session（sessionId=null），
 *  空 session 的 Landing 被 !isGenerating 守卫误伤 → 落到分支兜底空态（「选择左侧会话开始」），
 *  new-task 渲染撕裂。改为 per-session：只有本 Panel 绑定的 session 在流式才算 generating。
 *  landing 态 sessionId=null → streamingSessionId 恒不等 → isGenerating=false → Landing 正常渲染。
 *  [W1] isActive 作为 UI 层 SSOT：消除提交后到 message_start 之间空窗期的状态不一致。 */
const isGenerating = computed(
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
    isGenerating.value ||
    isCompacting.value,
)
/** getHistory 失败态（landing 重试出口，AC-2.6） */
const historyError = computed(() =>
  props.sessionId ? chat.failedHistory.has(props.sessionId) : false,
)

/** Landing 重试 → useSidebar.retryHistory（#2 AC-2.6） */
function onRetryHistory(): void {
  if (props.sessionId) void useSidebar().retryHistory(props.sessionId)
}

/** dead session「重新打开」：调 selectSession 触发 restore（重新 spawn pi），成功后 revive 重置 idle */
async function onReviveSession(): Promise<void> {
  if (!props.sessionId) return
  try {
    await useSidebar().selectSession(props.sessionId)
    sessionStore.revive(props.sessionId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toastError(`重新打开失败：${msg}`)
  }
}

/** 激活标识（对齐 draft-dual-panel.html SSOT）。
 *  层级语义：MainPanel(main) 是唯一 float-panel（bg-surface + border + shadow + radius）。
 *  Panel section 是它的内容区，底色按 panel 数量切两种语义——
 *  · 单 panel：section 透明，直接继承 MainPanel 的 surface（section 即 main 内容区，不再独立浮起）。
 *  · 双 panel：section 各自浮起（draft-dual-panel .panel 模型）——
 *    active → bg-elevated 微亮 + ring-1 accent-ring + opacity 1（焦点浮起）；
 *    standby → bg-surface + opacity 0.5 hover 回升 0.78（退后，设计稿明确写 opacity 表达主从）。
 *  SideDrawer 是 workspace-body 级 absolute 浮层（w-1/2，覆盖对侧），不参与 panel 的 flex 布局——
 *  panel 始终 flex-1 均分（单 panel 撑满、双 panel 各半），与 drawer 完全解耦，避免收窄态引发宽度异常。 */
const panelStateClass = computed(() => {
  if (props.active && props.isDual) {
    // active：ring 表达焦点（底色走 panelStyle 的 --panel-bg）
    return 'opacity-100 ring-1 ring-[var(--accent-ring)]'
  }
  if (!props.active && props.isDual) {
    return 'opacity-50 hover:opacity-[0.78]'
  }
  // 单 panel：无 ring、满 opacity（底色透明继承 MainPanel）
  return ''
})

/**
 * Panel 底色 + --panel-bg CSS 变量（供子组件如 sticky turn-meta 消费，保证浮层底色与所在 panel 一致）。
 * 单 panel：不设 background（透明继承 MainPanel 的 bg-surface），--panel-bg=surface 供子组件浮层对齐。
 * 双 active：background=bg-elevated，--panel-bg=bg-elevated。
 * 双 standby：background=bg-surface，--panel-bg=surface。
 */
const panelStyle = computed(() => {
  if (props.active && props.isDual) {
    return { background: 'var(--bg-elevated)', '--panel-bg': 'var(--bg-elevated)' }
  }
  if (!props.active && props.isDual) {
    return { background: 'var(--surface)', '--panel-bg': 'var(--surface)' }
  }
  // 单 panel：透明继承，--panel-bg 指向 surface（与 MainPanel 一致）
  return { '--panel-bg': 'var(--surface)' }
})
</script>
