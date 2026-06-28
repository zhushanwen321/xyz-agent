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
      @open-git="openDrawer('git')"
    />

    <!-- 渲染分支对齐 NewTaskFlow 状态机（修恢复空 session 的 chip 死锁）：
         - messageCount>0 → 对话流
         - new-task landing（无 session 或 flow.state==='landing'）→ Landing（chip 合法）
         - 已有空 session（有 sid 非 landing 态）→ 空对话态 + band composer（用户直输发该 session，不走 chip）
         - isGenerating 优先不渲染 Landing（AC-2.8）。
         旧逻辑仅凭 messageCount===0 渲染 Landing，恢复空 session 时 flow.state=idle → chip transition
         非法（idle→dir-popover）抛错。对齐 flow 后 Landing 只在 landing 态渲染，空 session 走空对话态。 -->
    <MessageStream v-if="sessionId && messageCount > 0" :session-id="sessionId" />
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

    <!-- SideDrawer：右抽屉容器（§4.10 F10），固定挂本 Panel（panel/spec.md）。
         Terminal/Browser/Git 三 tab。git 数据由 Panel 经 GIT_STATUS_KEY provide，GitPanel inject。
         状态控制下沉 useSideDrawer（§6.3 点5），Panel 仅作 slot 容器不持有 tab/dock 状态。 -->
    <SideDrawer
      :is-open="drawerOpen"
      :active-tab="drawerTab"
      :docked="drawerDocked"
      :session-id="sessionId"
      @close="closeDrawer"
      @set-tab="setDrawerTab"
      @toggle-dock="toggleDrawerDock"
    />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { MessageSquare } from '@lucide/vue'
import type { DerivedStatus } from '@/types'
import PanelHeader from './PanelHeader.vue'
import ProgressZone from './ProgressZone.vue'
import MessageStream from './MessageStream.vue'
import Composer from './Composer.vue'
import SideDrawer from './SideDrawer.vue'
import Landing from '@/components/new-task/Landing.vue'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { provideGitStatus } from '@/composables/features/useGitStatus'
import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useChatStore } from '@/stores/chat'
import { useSidebar } from '@/composables/features/useSidebar'

const props = defineProps<{
  panelId: string
  sessionId: string | null
  sessionLabel: string
  sessionDir: string
  gitBranch?: string
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
}>()

/** SideDrawer 控制（§6.3 点5 架构解耦）：open/dock/tab 状态下沉 composable，Panel 不直接持有 */
const {
  isOpen: drawerOpen,
  activeTab: drawerTab,
  docked: drawerDocked,
  open: openDrawer,
  close: closeDrawer,
  setTab: setDrawerTab,
  toggleDock: toggleDrawerDock,
} = useSideDrawer()

/** git 状态唯一数据源（panel/spec.md：git 移入抽屉后）。
 *  Panel 持有实例 → GIT_STATUS_KEY provide → GitPanel（抽屉内）与 PanelHeader 脏状态点共享。
 *  单实例避免双实例 stale（抽屉内 stage 后 header 点同步更新）。getter 形式随 props.sessionId 响应。 */
const git = provideGitStatus(() => props.sessionId)

/** 点击 panel body 切 active（双 panel 主从焦点）；点 header 按钮不误切（按钮自身 stopPropagation） */
function onPanelMouseDown(e: MouseEvent): void {
  if (!props.isDual || props.active) return
  // 按钮点击由 reka-ui/Button 内部处理，这里检查最近 button 祖先避免误切
  if ((e.target as HTMLElement).closest('button')) return
  emit('activate', props.panelId)
}

const chat = useChatStore()

const flow = useNewTaskFlow()

/** header 脏状态点所需指示（解包 git.indicator 供 template 透传给 PanelHeader props） */
const gitIndicator = computed(() => git.indicator.value)

/** 当前 session 消息数（未 hydrate / 无 session → 0） */
const messageCount = computed(() =>
  props.sessionId ? chat.getMessages(props.sessionId).length : 0,
)
/** 生成态优先：isStreaming 时不渲染 landing（AC-2.8） */
const isGenerating = computed(() => chat.isStreaming)
/** new-task landing 视图判据：完全无 session（首次启动/点新建）或 NewTaskFlow 处于 landing 态。
 *  Landing 的 directory/branch chip 仅在 flow.state==='landing' 时点击合法，故 Landing 只在此态渲染；
 *  恢复空 session（有 sid 无消息 但 flow.state=idle）不走 landing，避免 chip transition 非法死锁。 */
const isLandingView = computed(
  () => !props.sessionId || flow.state.value === 'landing',
)
/** band 内 Composer 渲染：new-task landing 态由 Landing 内嵌 composer 卡片承接，band 不重复渲染；
 *  已绑 session（含恢复的空 session，非 landing 态）→ band 渲染 composer 供直输；生成态始终挂。 */
const showPanelComposer = computed(
  () => (!!props.sessionId && !isLandingView.value) || isGenerating.value,
)
/** getHistory 失败态（landing 重试出口，AC-2.6） */
const historyError = computed(() =>
  props.sessionId ? chat.failedHistory.has(props.sessionId) : false,
)

/** Landing 重试 → useSidebar.retryHistory（#2 AC-2.6） */
function onRetryHistory(): void {
  if (props.sessionId) void useSidebar().retryHistory(props.sessionId)
}

/** 激活标识（workspace/spec.md）：单 panel 无标识；双 active = bg-elevated + ring-1 accent + opacity 1；双 standby = opacity 0.5 hover 回升 0.78 */
const panelStateClass = computed(() => {
  if (props.active && props.isDual) {
    return 'bg-bg-elevated opacity-100 ring-1 ring-[var(--accent-ring)]'
  }
  if (!props.active && props.isDual) {
    return 'opacity-50 hover:opacity-[0.78]'
  }
  return ''
})
</script>
