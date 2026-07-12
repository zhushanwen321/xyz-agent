<template>
  <!--
    容器组件 · PanelContainer（workspace/spec.md Panel 挂载点 + split 状态机）。
    读 panel store：单 panel 渲染 1 个 Panel（撑满），双 panel 渲染 2 个（主从）。
    双 panel 中缝用 gap + bg-border 实现（draft-dual-panel workspace-body 同款）。
    active panel 的 sessionId 跟随 session store.activeId（sidebar 选 session → 载入 active panel）。
    v1：双 panel 的第二 session 来源 G-023 DEFERRED，standby panel 暂显空态占位。

    SideDrawer 协调（panel/spec.md §未决项#1 v2 形态裁决）：drawer 固定挂本容器（单实例，跟随 active panel），
    按 panel 数量切两种定位模式（drawerMode computed 派生自 panel.isDual）：
    · 单 panel（isDual=false）→ mode='split'：drawer 作 flex 子项与 Panel 各占一半，并排不覆盖；
    · 双 panel（isDual=true） → mode='overlay'：drawer 作 absolute 浮层（w-1/2、z-30）覆盖对侧 standby panel。
    方向：host=P1 → drawer 贴右（direction='right'）；host=P2 → drawer 贴左（direction='left'）。
    overflow-hidden：overlay 模式下 drawer 是 absolute 子元素，溢出本容器时必须被裁，否则关闭按钮等右缘
    内容会飘出窗口不可见（sidebar 加宽后 workspace 变窄放大了该问题）；split 模式下 drawer 是 flex 子项
    不受此约束。drawer 的开/关动画用 opacity 淡入（SideDrawer.vue transition），避免 overlay 模式下
    translateX 位移被裁导致看不到动画。
    git 状态唯一数据源在此层 provide（按 active panel 的 session），GitPanel 注入共享。
  -->
  <div
    class="panel-container relative flex min-h-0 flex-1 overflow-hidden"
    :class="panel.isDual ? 'gap-px bg-border' : ''"
  >
    <Panel
      v-for="(leaf, i) in panel.panels"
      :key="leaf.id"
      :panel-id="leaf.id"
      :session-id="leaf.sessionId"
      :session-label="sessionLabelOf(leaf)"
      :session-dir="sessionDirOf(leaf)"
      :git-branch="gitBranchOf(leaf)"
      :git-indicator="gitIndicatorOf(leaf)"
      :status="statusOf(leaf)"
      :active="leaf.id === panel.activePanelId"
      :is-dual="panel.isDual"
      :is-first-panel="i === 0"
      @activate="panel.setActive"
      @split="onSplit"
      @new-session="onNewSession"
      @close="onClose(leaf.id)"
      @open-git="openDrawer('git')"
      @toggle-drawer="toggleDrawer()"
    />

    <!-- SideDrawer：workspace-body 级辅助视图容器（panel/spec.md v2）。单实例，跟随 active panel。
         mode 由 panel 数量决定：单 panel → split（flex 分栏各占一半）；双 panel → overlay（覆盖对侧 standby）。
         git 数据由本容器 provide，GitPanel inject。 -->
    <SideDrawer
      :is-open="drawerOpen"
      :active-tab="drawerTab"
      :docked="drawerDocked"
      :direction="drawerDirection"
      :mode="drawerMode"
      :session-id="activePanelSessionId"
      @close="closeDrawer"
      @set-tab="setDrawerTab"
      @toggle-dock="toggleDrawerDock"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PanelLeaf } from '@xyz-agent/shared'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSidebar } from '@/composables/features/useSidebar'
import { useSessionDerivations } from '@/composables/features/useSessionDerivations'
import { provideGitStatus } from '@/composables/features/useGitStatus'
import type { GitIndicator } from '@/composables/features/useGitStatus'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import Panel from '@/components/panel/Panel.vue'
import SideDrawer from '@/components/panel/SideDrawer.vue'

const panel = usePanelStore()
const session = useSessionStore()
const { newSessionToStandby } = useSidebar()
const { derivedStatus } = useSessionDerivations()

// sidebar 选 session → panel 载入的编排在 useSidebar.selectSession（主路径）
// 与 AppShell watch(navigation.pointer)（⌘[/⌘] 同步），不在此组件 watch：
// 避免空态不渲染→watch 不注册→loadSession 不触发的初始化时序死锁。

function sessionLabelOf(leaf: PanelLeaf): string {
  return leaf.sessionId ? session.list.find((s) => s.id === leaf.sessionId)?.label ?? '' : ''
}
function sessionDirOf(leaf: PanelLeaf): string {
  return leaf.sessionId ? session.list.find((s) => s.id === leaf.sessionId)?.cwd ?? '' : ''
}
function gitBranchOf(leaf: PanelLeaf): string | undefined {
  return leaf.sessionId ? session.list.find((s) => s.id === leaf.sessionId)?.gitBranch : undefined
}
function statusOf(leaf: PanelLeaf) {
  return leaf.sessionId ? derivedStatus(leaf.sessionId).value : 'done'
}

/** SideDrawer 控制（§6.3 点5 架构解耦）：workspace-body 单实例，跟随 active panel */
const {
  isOpen: drawerOpen,
  activeTab: drawerTab,
  docked: drawerDocked,
  open: openDrawer,
  close: closeDrawer,
  toggle: toggleDrawer,
  setTab: setDrawerTab,
  toggleDock: toggleDrawerDock,
} = useSideDrawer()

/** active panel leaf（drawer 关联的 panel；无 active 则回落到首个 panel） */
const activePanel = computed<PanelLeaf>(
  () => panel.panels.find((p) => p.id === panel.activePanelId) ?? panel.panels[0],
)

/** active panel 的 session（drawer widget 订阅 + git 状态数据源） */
const activePanelSessionId = computed<string | null>(() => activePanel.value?.sessionId ?? null)

/** git 状态唯一数据源（panel/spec.md：git 移入抽屉后）。
 *  在 PanelContainer 层按 active panel 的 session 持有实例 → GIT_STATUS_KEY provide →
 *  GitPanel（抽屉内）注入。单实例避免双实例 stale（抽屉内 stage 后同步更新）。getter 随 active panel 响应。 */
const git = provideGitStatus(() => activePanelSessionId.value)

/** drawer 贴边方向：host=P1→贴右，host=P2→贴左（panel/spec.md v2 / draft-detail-pane.html） */
const drawerDirection = computed<'right' | 'left'>(() => {
  const leaves = panel.panels
  const hostIndex = leaves.findIndex((p) => p.id === activePanel.value.id)
  // host 是首个（左）panel → 贴右；否则贴左
  return hostIndex === 0 ? 'right' : 'left'
})

/** drawer 布局模式：单 panel → split（flex 分栏各占一半，不覆盖）；双 panel → overlay（absolute 覆盖对侧 standby） */
const drawerMode = computed<'split' | 'overlay'>(() => (panel.isDual ? 'overlay' : 'split'))

/**
 * 各 Panel 透传给 PanelHeader 的 git 脏状态指示（仅 active panel 显示真实 git 状态；
 * standby panel 无独立 session 绑定时回落空指示，git 按钮 v-if 自隐藏）。
 */
function gitIndicatorOf(leaf: PanelLeaf): GitIndicator | undefined {
  // 抽屉只跟随 active panel 的 git；非 active panel 不显示 git 入口（避免歧义）
  if (leaf.id !== activePanel.value?.id) return undefined
  return git.indicator.value
}

function onSplit(): void {
  panel.split()
}

/**
 * 新建会话（双 panel）：替换待机侧为新 session 并聚焦，active 侧 session 不动
 * （panel/spec.md 状态与交互）。编排在 useSidebar.newSessionToStandby。
 */
function onNewSession(): void {
  void newSessionToStandby()
}
function onClose(panelId: string): void {
  panel.close(panelId)
}
</script>
