<template>
  <!--
    容器组件 · PanelContainer（workspace/spec.md Panel 挂载点）。
    v2：移除 split 后恒单 Panel（撑满），不再有单/双 panel 状态机。
    active panel 的 sessionId 跟随 session store.activeId（sidebar 选 session → 载入 panel）。

    SideDrawer 协调：drawer 固定挂本容器（单实例），恒作 flex 子项与 Panel 各占一半并排（mode='split'），
    贴右展开（direction='right'）。单 panel 下不再有 overlay 浮层模式。
    git 状态唯一数据源在此层 provide（按 panel 的 session），GitPanel 注入共享。
  -->
  <div class="panel-container relative flex min-h-0 flex-1 overflow-hidden">
    <Panel
      :panel-id="leaf.id"
      :session-id="leaf.sessionId"
      :session-label="sessionLabelOf(leaf)"
      :session-dir="sessionDirOf(leaf)"
      :session-file="sessionFileOf(leaf)"
      :git-branch="gitBranchOf(leaf)"
      :git-indicator="gitIndicatorOf(leaf)"
      :status="statusOf(leaf)"
      @open-git="openDrawer('git')"
      @toggle-drawer="toggleDrawer()"
    />

    <!-- SideDrawer：workspace-body 级辅助视图容器。单实例，跟随 panel。
         恒 mode='split'（flex 分栏各占一半），direction='right'（贴右）。
         git 数据由本容器 provide，GitPanel inject。 -->
    <SideDrawer
      :is-open="drawerOpen"
      :active-tab="drawerTab"
      :docked="drawerDocked"
      :session-id="panelSessionId"
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
import { useSessionDerivations } from '@/composables/features/useSessionDerivations'
import { provideGitStatus } from '@/composables/features/useGitStatus'
import type { GitIndicator } from '@/composables/features/useGitStatus'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import Panel from '@/components/panel/Panel.vue'
import SideDrawer from '@/components/panel/SideDrawer.vue'

const panel = usePanelStore()
const session = useSessionStore()
const { derivedStatus } = useSessionDerivations()

// sidebar 选 session → panel 载入的编排在 useSidebar.selectSession（主路径）
// 与 AppShell watch(navigation.pointer)（⌘[/⌘] 同步），不在此组件 watch：
// 避免空态不渲染→watch 不注册→loadSession 不触发的初始化时序死锁。

/** 唯一 panel leaf（v2：恒单 panel，currentLeaf 即整个 layout） */
const leaf = computed<PanelLeaf>(() => panel.currentLeaf)

function sessionLabelOf(l: PanelLeaf): string {
  return l.sessionId ? session.list.find((s) => s.id === l.sessionId)?.label ?? '' : ''
}
function sessionDirOf(l: PanelLeaf): string {
  return l.sessionId ? session.list.find((s) => s.id === l.sessionId)?.cwd ?? '' : ''
}
function sessionFileOf(l: PanelLeaf): string | undefined {
  return l.sessionId ? session.list.find((s) => s.id === l.sessionId)?.sessionFile : undefined
}
function gitBranchOf(l: PanelLeaf): string | undefined {
  return l.sessionId ? session.list.find((s) => s.id === l.sessionId)?.gitBranch : undefined
}
function statusOf(l: PanelLeaf) {
  return l.sessionId ? derivedStatus(l.sessionId).value : 'done'
}

/** SideDrawer 控制（§6.3 点5 架构解耦）：workspace-body 单实例 */
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

/** panel 的 session（drawer widget 订阅 + git 状态数据源） */
const panelSessionId = computed<string | null>(() => leaf.value?.sessionId ?? null)

/** git 状态唯一数据源（panel/spec.md：git 移入抽屉后）。
 *  在 PanelContainer 层按 panel 的 session 持有实例 → GIT_STATUS_KEY provide →
 *  GitPanel（抽屉内）注入。单实例避免双实例 stale（抽屉内 stage 后同步更新）。getter 随 panel 响应。 */
const git = provideGitStatus(() => panelSessionId.value)

/**
 * 各 Panel 透传给 PanelHeader 的 git 脏状态指示。
 * git 状态由本容器 provideGitStatus 持有（不依赖具体 leaf），参数仅为与其他 xxxOf(leaf) 保持调用一致。
 */
function gitIndicatorOf(_l: PanelLeaf): GitIndicator | undefined {
  return git.indicator.value
}
</script>
