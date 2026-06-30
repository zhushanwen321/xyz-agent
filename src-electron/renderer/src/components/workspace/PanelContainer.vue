<template>
  <!--
    容器组件 · PanelContainer（workspace/spec.md Panel 挂载点 + split 状态机）。
    读 panel store：单 panel 渲染 1 个 Panel（撑满），双 panel 渲染 2 个（主从）。
    双 panel 中缝用 gap + bg-border 实现（draft-dual-panel workspace-body 同款）。
    active panel 的 sessionId 跟随 session store.activeId（sidebar 选 session → 载入 active panel）。
    v1：双 panel 的第二 session 来源 G-023 DEFERRED，standby panel 暂显空态占位。

    SideDrawer 协调（panel/spec.md §未决项#1 v2 形态裁决）：drawer 是 workspace-body 级 absolute
    浮层、width:50%，固定挂本容器（单实例，跟随 active panel）。drawer 不参与 panel 的 flex 布局——
    panel 始终 flex-1 均分（单 panel 撑满、双 panel 各半），drawer 直接覆盖 workspace 的另一半空间。
    方向：host=P1 → drawer 贴右（direction='right'）；host=P2 → drawer 贴左（direction='left'）。
    overflow-hidden：drawer 是 absolute 子元素，溢出本容器时必须被裁，否则关闭按钮等右缘内容会
    飘出窗口不可见（sidebar 加宽后 workspace 变窄放大了该问题）。drawer 的滑入/滑出改用 opacity
    淡入（SideDrawer.vue transition），避免 translateX 位移被裁导致看不到动画。
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
    />

    <!-- SideDrawer：workspace-body 级 absolute 浮层，width:50%，覆盖 workspace 的另一半（panel/spec.md v2）。
         不参与 panel flex 布局——panel 始终 flex-1 均分。跟随 active panel 方向：host=P1→贴右，host=P2→贴左。
         git 数据由本容器 provide，GitPanel inject。 -->
    <SideDrawer
      :is-open="drawerOpen"
      :active-tab="drawerTab"
      :docked="drawerDocked"
      :direction="drawerDirection"
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
import { provideGitStatus } from '@/composables/features/useGitStatus'
import type { GitIndicator } from '@/composables/features/useGitStatus'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import Panel from '@/components/panel/Panel.vue'
import SideDrawer from '@/components/panel/SideDrawer.vue'

const panel = usePanelStore()
const session = useSessionStore()
const { derivedStatus, newSessionToStandby } = useSidebar()

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
