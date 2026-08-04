<template>
  <!--
    容器组件 · PanelContainer（workspace/spec.md Panel 挂载点）。
    v2：移除 split 后恒单 Panel（撑满），不再有单/双 panel 状态机。
    active panel 的 sessionId 跟随 session store.activeId（sidebar 选 session → 载入 panel）。

    Drawer 协调（W4 drawer-shell-integration）：drawer 固定挂本容器（单实例），恒作 flex 子项与
    Panel 各占一半并排（mode='split'），贴右展开（direction='right'）。单 panel 下不再有 overlay
    浮层模式。本容器渲染跨端共享容器 DrawerPanel（@xyz-agent/ui/features/drawer，W3 迁移自旧
    SideDrawer.vue），并按 C2 contract 经默认 slot 注入桌面独占内容面板（GitPanel/TerminalView/
    BrowserPane 等，v-if chain 对齐旧 SideDrawer 内容区结构）。git 状态唯一数据源在此层 provide
    （按 panel 的 session），GitPanel 注入共享。

    壳层职责（W3 C3 裁决，旧 SideDrawer 逻辑迁移至此）：widget 订阅编排（useSessionEvents 接
    extension:widget/widgetGui/status → core createDrawerBuffers 喂数据，D3 留壳注入）+ ESC 关闭
    （window keydown 桌面副作用）+ AC-13 unread badge（chatStore 消息数感知，经 DrawerPanel
    header-extra slot 挂载）+ hasTasksData 计算（tasksStore，T3 壳裁剪）。控制态（isOpen/
    activeTab/docked）读 core drawer 域（useDrawerControl + coordination 公开 API），分区键经
    useSideDrawer 兼容层模块顶层 bindDrawerSessionId 维持（C1：兼容层本 wave 保留）。
  -->
  <SplitterGroup
    direction="horizontal"
    auto-save-id="workspace-drawer-split"
    class="panel-container relative min-h-0 flex-1 overflow-hidden"
    @layout="onSplitterLayout"
  >
    <SplitterPanel id="main-panel" :order="1" :min-size="40" :default-size="50">
      <Panel
        :panel-id="leaf.id"
        :session-id="leaf.sessionId"
        :session-label="sessionLabelOf(leaf)"
        :session-dir="sessionDirOf(leaf)"
        :session-file="sessionFileOf(leaf)"
        :git-branch="gitBranchOf(leaf)"
        :git-indicator="gitIndicatorOf(leaf)"
        :status="statusOf(leaf)"
        @open-git="openDrawerTab('git')"
        @toggle-drawer="toggleDrawer()"
      />
    </SplitterPanel>

    <!-- Drawer：workspace-body 级辅助视图容器。单实例，跟随 panel。
         作为 SplitterPanel 子项，宽度可拖动调整（ResizeHandle），autoSaveId 持久化。
         drawer 关闭时连同 ResizeHandle 一起卸载（v-if），Splitter 自动回单 panel。
         DrawerPanel 内部仍有自己的 aside v-if（Transition 动画），与外层 v-if 不冲突
         （外层先判断，关闭时内层根本不挂载）。git 数据由本容器 provide，GitPanel inject。
         内容区按 activeTab 经默认 slot 注入桌面独占面板（C2 contract：该 tab 无桌面面板时
         不注入 → DrawerPanel 内置 widget 区 fallback 渲染）。 -->
    <template v-if="drawerOpen">
      <SplitterResizeHandle
        id="drawer-handle"
        class="workspace-resize-handle relative w-px shrink-0 bg-border transition-colors duration-150 ease hover:bg-border-strong data-[state=drag]:bg-accent"
      />
      <SplitterPanel id="drawer-panel" :order="2" :min-size="20" :max-size="60" :default-size="50">
        <DrawerPanel
          :is-open="drawerOpen"
          :active-tab="drawerTab"
          :docked="drawerDocked"
          :session-id="panelSessionId"
          :active-gui-component="activeGuiComponent"
          :active-lines="activeLines"
          :active-lines-meta="activeLinesMeta"
          :status-entries="statusEntries"
          :has-tasks-data="hasTasksData"
          @close="closeDrawer"
          @set-tab="setDrawerTab"
          @toggle-dock="toggleDrawerDock"
        >
          <!-- 桌面独占内容面板（C2 v-if chain，对齐旧 SideDrawer 内容区结构）：
               Git tab → GitPanel（inject GIT_STATUS_KEY，非 git 仓库组件内自隐藏走空态）
               Doc tab → CommandDocPanel（selectedCommandName 由 core 瞬时参数指定）
               Detail tab → DetailPane（useDetailPane watch selectedPath 自动加载）
               Browser tab 有 browserUrl → BrowserPane（嵌入式 WebContentsView 导航）；
                 无 browserUrl → 不注入 → DrawerPanel 内置 widget 区 fallback（widget 通路）
               Tasks tab → TasksPanel（tasks store 按 sessionId 分区只读渲染）
               Terminal tab → TerminalView（PTY 优先，交互式终端） -->
          <GitPanel v-if="drawerTab === 'git'" />
          <CommandDocPanel v-else-if="drawerTab === 'doc'" :session-id="panelSessionId" />
          <DetailPane v-else-if="drawerTab === 'detail'" :session-id="panelSessionId" />
          <BrowserPane
            v-else-if="drawerTab === 'browser' && browserUrl"
            :session-id="panelSessionId ?? ''"
            :url="browserUrlForRender"
          />
          <TasksPanel v-else-if="drawerTab === 'tasks'" :session-id="panelSessionId" />
          <TerminalView v-else-if="drawerTab === 'terminal'" :session-id="panelSessionId" />
          <!-- header-extra：AC-13 unread badge 壳侧挂载点（W4；chatStore 消息数感知，C3 壳层职责） -->
          <template #header-extra>
            <div
              v-if="unreadCount > 0"
              class="flex items-center gap-0.5 rounded-full bg-accent px-1.5 py-0.5"
              data-testid="drawer-unread-badge"
              :title="t('panel.sideDrawer.unreadMessages', { count: unreadCount })"
            >
              <span class="size-1.5 animate-pulse rounded-full bg-neutral-fg" />
              <span class="font-mono text-[10px] text-neutral-fg">{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
            </div>
          </template>
        </DrawerPanel>
      </SplitterPanel>
    </template>
  </SplitterGroup>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PanelLeaf } from '@xyz-agent/shared'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import {
  bindDrawerSessionId,
  useDrawerControl,
  openDrawerTab,
  closeDrawer,
  toggleDrawer,
  setDrawerTab,
  toggleDrawerDock,
  createDrawerBuffers,
  browserUrl,
} from '@xyz-agent/core/domain/drawer'
import { useTasksStore } from '@xyz-agent/core'
import { DrawerPanel } from '@xyz-agent/ui/features/drawer'
import { usePanelStore } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import { useSessionDerivations } from '@/composables/features/useSessionDerivations'
import { useSessionEvents } from '@/composables/features/useSessionEvents'
import { provideGitStatus } from '@/composables/features/useGitStatus'
import type { GitIndicator } from '@/composables/features/useGitStatus'
import { useChatStore } from '@/stores/chat'
import Panel from '@/components/panel/Panel.vue'
import GitPanel from '@/components/panel/GitPanel.vue'
import CommandDocPanel from '@/components/panel/CommandDocPanel.vue'
import DetailPane from '@/components/panel/DetailPane.vue'
import BrowserPane from '@/components/panel/BrowserPane.vue'
import TasksPanel from '@/components/panel/TasksPanel.vue'
import TerminalView from '@/components/panel/TerminalView.vue'
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'reka-ui'

const { t } = useI18n()

const panel = usePanelStore()
const session = useSessionStore()
const tasksStore = useTasksStore()
const chatStore = useChatStore()
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

/** Drawer 控制态（§6.3 点5 架构解耦）：workspace-body 单实例。
 *  读 core drawer 域当前分区（isOpen/activeTab/docked）。分区键显式绑定 panel store 的
 *  focusedSessionId（惰性 computed，首次求值 pinia 已 active）——本容器自持绑定，不依赖
 *  useSideDrawer 兼容层的模块顶层 bind 副作用（C1：兼容层保留仅服务残留消费方，新代码直连 core）。
 *  方法委托 core coordination 公开 API（openDrawerTab 等，含 FR-9 pendingOpen 清理语义）。
 *  bindDrawerSessionId 幂等：同语义 computed 重复绑定不报错（useSidebar 兼容层若已绑则覆盖，
 *  值等价）。 */
bindDrawerSessionId(computed<string | null>(() => usePanelStore().focusedSessionId))
const { isOpen: drawerOpen, activeTab: drawerTab, docked: drawerDocked } = useDrawerControl()

/** panel 的 session（drawer widget 订阅 + git 状态数据源） */
const panelSessionId = computed<string | null>(() => leaf.value?.sessionId ?? null)

/**
 * widget/status 缓冲 + extension 事件订阅编排（壳层，D3）：原 useDrawerWidgetBuffers.ts 逻辑
 * 内联至此（W4 TR2）。core createDrawerBuffers 为 SSOT（reactive 分区 + computed 派生 + update
 * 方法），本壳只持订阅 + 调 update 喂数据。onMessage handler 收第二参数 sid（订阅时捕获的消息
 * 所属 session），调 updateFor(sid) 写该 sid 分区（M1 竞态修复：退订窗口内旧 sid 迟到消息
 * 不污染新 sid）。本容器单实例挂载（同旧 SideDrawer），subscription 随组件生命周期管理。
 */
const buffers = createDrawerBuffers(panelSessionId, drawerTab)
// 解构 view computed 供模板传 props 给 DrawerPanel（模板引用需 script 显式定义，否则渲染 undefined）
const { activeGuiComponent, activeLines, activeLinesMeta, statusEntries } = buffers
const onMessage = useSessionEvents(panelSessionId)
// extension:widget：按 widgetKey 路由到 terminal/browser tab，未匹配走 fallback
onMessage('extension:widget', (msg, sid) => {
  const payload = msg.payload
  buffers.updateWidget(sid, payload.widgetKey, payload.lines)
})
// extension:widgetGui（spec §9.1）：结构化 GUI 组件，按 widgetKey 路由到 tab，覆盖纯文本 lines。
// gui === null 表示清除（core 容器内删 guiWidgetsByTab 条目 + 清对应 tab 纯文本 lines）
onMessage('extension:widgetGui', (msg, sid) => {
  const payload = msg.payload
  buffers.updateWidgetGui(sid, payload.widgetKey, payload.gui as GuiComponent | null)
})
// extension:status：statusKey 维度聚合，同 key 覆盖（透传 textRaw 供 AnsiText 着色）
onMessage('extension:status', (msg, sid) => {
  const payload = msg.payload
  buffers.updateStatus(sid, payload.statusKey, payload.text, payload.textRaw)
})

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

/** tasks 条件 tab（W3 T3 壳裁剪）：有 goal/todo 数据才显示 tasks tab icon。
 *  TODO(@P4-§6.7-delete)：tasks store 是 D9 存根过渡依赖，P4 时随 tasks 域归位替换。 */
const hasTasksData = computed(() => (panelSessionId.value ? tasksStore.hasData(panelSessionId.value) : false))

/** browserUrl 瞬时参数（core coordination 模块级单例，消费后清空）。
 *  browser tab 传给 BrowserPane 触发导航；为空（null）时传空字符串让 BrowserPane 显空态。
 *  注：无 browserUrl 时 browser tab 不注入 BrowserPane，走 DrawerPanel 内置 widget 区 fallback（C2）。 */
const browserUrlForRender = computed(() => browserUrl.value ?? '')

// ── AC-13：drawer 打开期间 agent 新消息感知（壳层职责，C3；旧 SideDrawer 逻辑迁移）──
// drawer 打开时对话流被遮挡，agent 新消息需非侵入式感知（spec §4.5）。
// 机制：drawer isOpen 时 watch 当前 session 消息数增长，累加 unreadCount；
// 用户关 drawer（回对话流）或切 session 时清零。经 DrawerPanel header-extra slot 注入 badge。
const unreadCount = ref(0)
let prevSid = panelSessionId.value
watch(
  () => [drawerOpen.value, panelSessionId.value] as const,
  ([open, sid], [wasOpen]) => {
    // drawer 关闭时清零（用户回到对话流，角标无意义）
    if (wasOpen && !open) {
      unreadCount.value = 0
    }
    // 切 session 时清零（per-session 计数，不跨 session 累加）
    if (sid !== prevSid) {
      unreadCount.value = 0
      prevSid = sid
    }
  },
)
// 消息数增长时（drawer 打开期间 agent 新消息到达）→ 累加计数
watch(
  () => (panelSessionId.value ? chatStore.getMessages(panelSessionId.value).length : 0),
  (newLen, oldLen) => {
    if (drawerOpen.value && panelSessionId.value && newLen > oldLen) {
      unreadCount.value += newLen - oldLen
    }
  },
)

/**
 * ESC 关闭抽屉（panel/spec.md：抽屉是浮层，ESC 收起）。壳层职责（W3 C3；旧 SideDrawer onKeyDown
 * 迁移）。仅在 drawer 打开时挂监听，避免抽屉关闭后仍抢全局 keydown（如 composer 输入态）。
 * 单实例安全：drawer 由 PanelContainer 单实例挂载（本组件注释「drawer 固定挂本容器，单实例」），
 * watch(drawerOpen) 挂/卸全局 keydown 不会重复注册（规则 2）。
 */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeDrawer()
  }
}
watch(
  () => drawerOpen.value,
  (open) => {
    if (open) window.addEventListener('keydown', onKeyDown)
    else window.removeEventListener('keydown', onKeyDown)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})

/**
 * Splitter layout 变化（拖动 ResizeHandle / panel 条件渲染挂卸 / group 尺寸变化）时，
 * 经 window CustomEvent 通知 BrowserPane 重算 viewport rect 并推给主进程 WebContentsView setBounds。
 * 补充 BrowserPane 内 ResizeObserver 在 SplitterPanel overflow:hidden 容器 + reka-ui 高频拖动下
 * 触发不可靠的缺口（RO 双保险，不替换）。事件名带 xyz 前缀防冲突。
 */
function onSplitterLayout() {
  window.dispatchEvent(new CustomEvent('xyz:splitter-layout'))
}
</script>
