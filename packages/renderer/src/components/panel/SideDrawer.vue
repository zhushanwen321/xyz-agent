<!--
  SideDrawer —— workspace-body 级辅助视图容器，承载 Terminal/Browser/Git/Doc/Detail 五个 tab。
  Terminal/Browser 走 widget 订阅；Git tab 由 GitPanel.vue inject git 状态；Doc/Detail 各自独立。

  形态（v2：单 panel 恒 split 模式）：drawer 是 PanelContainer 的 flex 子项，与 Panel 各 flex-1 均分，
  并排占 workspace 一半，贴右展开（border-l 分隔）。不再有 overlay 浮层模式（原双 panel 专属）。

  状态控制走 useSideDrawer（§6.3 点5 架构解耦）：本组件只接收 isOpen/activeTab/docked props + emit
  close/set-tab/toggle-dock，不持有状态。widget 订阅（#11 W3a）在本组件按 props.sessionId
  接入 useSessionEvents.onMessage，按 widgetKey 路由到 terminal/browser tab。
  Git tab 不走 widget——数据由 PanelContainer 经 GIT_STATUS_KEY provide，GitPanel 自行 inject，
  本通用容器不持有 git props（保持容器纯净，不污染通用 tab 范式）。
-->
<template>
  <Transition name="drawer-slide-right">
    <aside
      v-if="isOpen"
      :class="asideClass"
      :aria-label="t('panel.sideDrawer.title')"
    >
      <!-- header：tab 栏（仅 icon，左）+ 钉住/关闭（右）。label 收进 title 供 hover 查看。 -->
      <header class="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div class="flex flex-1 gap-0.5">
          <Button
            v-for="t in tabs"
            :key="t.key"
            variant="ghost"
            class="size-7 shrink-0 justify-center rounded-sm p-0"
            :class="activeTab === t.key ? 'bg-accent-soft text-accent' : 'text-neutral-mid'"
            :title="t.label"
            :data-testid="`drawer-tab-${t.key}`"
            @click="emit('set-tab', t.key)"
          >
            <component :is="t.icon" class="size-3.5" />
          </Button>
        </div>

        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0"
          :class="docked ? 'text-accent' : 'text-neutral-dim'"
          :title="docked ? t('panel.sideDrawer.unpin') : t('panel.sideDrawer.pin')"
          @click="emit('toggle-dock')"
        >
          <PinOff v-if="docked" class="size-3" />
          <Pin v-else class="size-3" />
        </Button>
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
          :title="t('panel.sideDrawer.close')"
          @click="emit('close')"
        >
          <X class="size-3" />
        </Button>
        <!-- AC-13：drawer 打开期间 agent 新消息角标（脉动蓝点 + 计数，非侵入式） -->
        <div
          v-if="unreadCount > 0"
          class="flex items-center gap-0.5 rounded-full bg-accent px-1.5 py-0.5"
          data-testid="drawer-unread-badge"
          :title="t('panel.sideDrawer.unreadMessages', { count: unreadCount })"
        >
          <span class="size-1.5 animate-pulse rounded-full bg-neutral-fg" />
          <span class="font-mono text-[10px] text-neutral-fg">{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
        </div>
      </header>

      <!-- 内容区：Git / Terminal / Browser。
           Git tab → GitPanel（inject GIT_STATUS_KEY，自取 git 全量状态；非 git 仓库组件内自隐藏走空态）。
           Terminal tab → TerminalView（PTY 优先，交互式终端；决策 4-B，widget 死路径保留为非 terminal tab fallback）。
           Browser → widget 订阅（#11 W3a），按 widgetKey 路由（mapWidgetKeyToTab）。 -->
      <div class="min-h-0 flex-1 overflow-auto">
        <!-- Git tab：全量 git 状态 + 暂存/提交（非 git 仓库 GitPanel 内自隐藏，此处显空态） -->
        <GitPanel v-if="activeTab === 'git'" />
        <!-- Doc tab：命令/skill 详细文档（selectedCommandName 指定，CommandDocPanel 内自取 commandStore + skills） -->
        <CommandDocPanel v-else-if="activeTab === 'doc'" :session-id="sessionId" />
        <!-- Detail tab：文件预览（#6，useDetailPane watch selectedPath 自动加载，禁 v-html） -->
        <DetailPane v-else-if="activeTab === 'detail'" :session-id="sessionId" />
        <!-- Browser tab：嵌入式浏览器（WebContentsView，#browser-drawer Wave 2 + Wave 5）。
             Wave 5 AC-18 widget 回落：有 browserUrl（刚点链接）时显 BrowserPane 导航；
             无 browserUrl 时回落到 widget 通路（extension 推的 browser/preview widget 显示）。
             已加载的网页由主进程 view keep-alive 保留，重新点链接时 BrowserPane remount 恢复。-->
        <BrowserPane
          v-else-if="activeTab === 'browser' && browserUrl"
          :session-id="sessionId ?? ''"
          :url="browserUrlForRender"
        />
        <!-- Tasks tab：goal 卡片 + todo 列表（tasks store 按 sessionId 分区，只读渲染） -->
        <TasksPanel v-else-if="activeTab === 'tasks'" :session-id="sessionId" />
        <!-- Terminal tab：PTY 优先渲染交互式终端（TerminalView 内管 PTY 生命周期 + scrollback 回放）。
             widget 死路径（extension:widget 推 terminal 关键词）经查证 0 命中，PTY 接管后不再触发。 -->
        <TerminalView v-else-if="activeTab === 'terminal'" :session-id="sessionId" />
        <!-- active tab 有结构化 GUI widget（extension:widgetGui）→ 优先 GuiComponentRenderer 渲染 -->
        <div
          v-else-if="activeGuiComponent"
          class="flex h-full flex-col gap-0 overflow-auto p-2"
        >
          <GuiComponentRenderer :component="activeGuiComponent" />
        </div>
        <!-- active tab 有 widget 内容 → 渲染等宽文本输出（每行一个 div，font-mono + pre-wrap） -->
        <div
          v-else-if="activeLines.length"
          class="flex h-full flex-col gap-0 overflow-auto p-2"
          :class="activeLinesMeta.unknown ? 'opacity-80' : ''"
        >
          <div
            v-if="activeLinesMeta.unknown"
            class="mb-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10px] text-neutral-mid"
          >
            {{ t('panel.sideDrawer.unknownWidget') }}：{{ activeLinesMeta.key }}
          </div>
          <code
            v-for="(line, i) in activeLines"
            :key="i"
            class="block whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.45] text-neutral-fg/90"
            >{{ line }}</code
          >
        </div>
        <!-- active tab 无 widget 内容 → 空态占位 -->
        <div
          v-else
          class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
        >
          <component :is="activeTabMeta.icon" class="size-6 text-neutral-dim opacity-40" />
          <p class="text-[12px] text-neutral-dim opacity-70">{{ activeTabMeta.emptyText }}</p>
          <p class="text-[11px] text-neutral-dim opacity-50">{{ activeTabMeta.emptyHint }}</p>
        </div>
      </div>

      <!-- extension status 底栏（对称于 onWidget 订阅）：按 statusKey 聚合最新 text。
           无 status 推送时不占位，避免空态挤压内容区。 -->
      <footer
        v-if="statusEntries.length"
        class="flex flex-col gap-0.5 border-t border-border px-2 py-1"
      >
        <div
          v-for="entry in statusEntries"
          :key="entry.statusKey"
          class="flex items-center gap-1.5 font-mono text-[10px]"
        >
          <span class="shrink-0 text-neutral-dim">{{ entry.statusKey }}</span>
          <!-- textRaw 有 ANSI 着色 → AnsiText 渲染保留颜色；否则纯文本兜底。
               容器承载 truncate（min-w-0 + overflow-hidden + ellipsis），避免与 AnsiText 内部 whitespace-pre-wrap 冲突。 -->
          <div v-if="entry.textRaw" class="min-w-0 flex-1 overflow-hidden">
            <AnsiText :content="entry.textRaw" class="block truncate text-neutral-mid" />
          </div>
          <span v-else class="min-w-0 flex-1 truncate text-neutral-mid">{{ entry.text }}</span>
        </div>
      </footer>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import { Terminal as TerminalIcon, Globe, GitBranch, BookOpen, FileText, Pin, PinOff, X, CheckSquare } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import GitPanel from './GitPanel.vue'
import CommandDocPanel from './CommandDocPanel.vue'
import DetailPane from './DetailPane.vue'
import BrowserPane from './BrowserPane.vue'
import TasksPanel from './TasksPanel.vue'
import TerminalView from './TerminalView.vue'
import GuiComponentRenderer from './message-stream/GuiComponentRenderer.vue'
import { AnsiText } from '@xyz-agent/ui'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { useDrawerWidgetBuffers } from '@/composables/features/useDrawerWidgetBuffers'
import { useTasksStore } from '@xyz-agent/core'
import { useChatStore } from '@/stores/chat'

const props = defineProps<{
  isOpen: boolean
  activeTab: SideDrawerTab
  docked: boolean
  /** widget 订阅的 session 标识（#11 W3a）：为 null 不订阅 */
  sessionId: string | null
}>()

const emit = defineEmits<{
  close: []
  'set-tab': [tab: SideDrawerTab]
  'toggle-dock': []
}>()

const { t } = useI18n()

const tasksStore = useTasksStore()
const chatStore = useChatStore()

// ── AC-13：drawer 打开期间 agent 新消息感知 ──────────────────────────────
// drawer 打开时对话流被遮挡，agent 新消息需非侵入式感知（spec §4.5）。
// 机制：drawer isOpen 时 watch 当前 session 消息数增长，累加 unreadCount；
// 用户关 drawer（回对话流）或切回 chat 相关操作时清零。
const unreadCount = ref(0)
watch(
  () => [props.isOpen, props.sessionId] as const,
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
let prevSid = props.sessionId
// 消息数增长时（drawer 打开期间 agent 新消息到达）→ 累加计数
watch(
  () => (props.sessionId ? chatStore.getMessages(props.sessionId).length : 0),
  (newLen, oldLen) => {
    if (props.isOpen && props.sessionId && newLen > oldLen) {
      unreadCount.value += newLen - oldLen
    }
  },
)

// useSideDrawer 暴露的 browserUrl（点击 agent 链接时设置，模块级单例 ref）。
// browser tab 传给 BrowserPane 触发导航。为空（null）时传空字符串让 BrowserPane 显空态。
// 注：useSideDrawer 的 isOpen/activeTab 等控制态由本组件 props 接收（父组件管理），
// 此处只取 browserUrl 瞬时参数。
const { browserUrl } = useSideDrawer()
const browserUrlForRender = computed(() => browserUrl.value ?? '')

/**
 * aside 容器 class（v2：单 panel 恒 split 模式）：
 * drawer 作为 PanelContainer SplitterGroup 的 SplitterPanel 子项，尺寸由 SplitterPanel 接管
 * （inline flexGrow），故此处不再 flex-1；左右分隔线交给 SplitterResizeHandle（workspace-resize-handle）。
 * 底色用 bg-surface（与 Panel 内容区一致——Panel section 透明继承 MainPanel 的 surface，
 * drawer 同色与之并列为 main 内容区）。
 */
const asideClass = computed<string[]>(() => [
  'flex h-full flex-col bg-surface',
  'relative min-w-0',
])

interface TabMeta {
  key: SideDrawerTab
  label: string
  icon: Component
  emptyText: string
  emptyHint: string
}

/** tab 元信息（§6.3 点2：Terminal/Browser/Git）。Git tab 内容为 GitPanel（inject 数据）。
 *  Tasks tab 仅在当前 session 有 goal/todo 数据时追加（避免空 icon 噪音）。 */
const tabs = computed<TabMeta[]>(() => {
  const base: TabMeta[] = [
    {
      key: 'terminal',
      label: t('panel.sideDrawer.tabTerminal'),
      icon: TerminalIcon,
      emptyText: t('panel.sideDrawer.noTerminal'),
      emptyHint: t('panel.sideDrawer.terminalHint'),
    },
    {
      key: 'browser',
      label: t('panel.sideDrawer.tabBrowser'),
      icon: Globe,
      emptyText: t('panel.sideDrawer.noBrowser'),
      emptyHint: t('panel.sideDrawer.browserHint'),
    },
    {
      key: 'git',
      label: t('panel.sideDrawer.tabGit'),
      icon: GitBranch,
      emptyText: t('panel.sideDrawer.noGit'),
      emptyHint: t('panel.sideDrawer.gitHint'),
    },
    {
      key: 'doc',
      label: t('panel.sideDrawer.tabDoc'),
      icon: BookOpen,
      emptyText: t('panel.sideDrawer.noDoc'),
      emptyHint: t('panel.sideDrawer.docHint'),
    },
    {
      key: 'detail',
      label: t('panel.sideDrawer.tabDetail'),
      icon: FileText,
      emptyText: t('panel.sideDrawer.noFileSelected'),
      emptyHint: t('panel.sideDrawer.detailHint'),
    },
  ]
  // Tasks tab 条件 push：有 goal/todo 数据才显示 icon（避免无数据时占位）
  if (props.sessionId && tasksStore.hasData(props.sessionId)) {
    base.push({
      key: 'tasks',
      label: t('panel.sideDrawer.tabTasks'),
      icon: CheckSquare,
      emptyText: t('panel.sideDrawer.noTasks'),
      emptyHint: t('panel.sideDrawer.tasksHint'),
    })
  }
  return base
})

const activeTabMeta = computed(() => tabs.value.find((tab) => tab.key === props.activeTab) ?? tabs.value[0])

/**
 * widget/status 缓冲 + extension 事件订阅编排已抽到 useDrawerWidgetBuffers（关注点分离 +
 * `<script setup>` 行数控制）。composable 内部按 ADR-0049 W4 Map 分区派管理 per-session 状态，
 * onMessage handler 调 updateFor(sid) 写订阅时 sid 分区（M1 竞态修复）。本组件只消费四个 computed。
 */
const { activeGuiComponent, activeLines, activeLinesMeta, statusEntries } = useDrawerWidgetBuffers(
  toRef(props, 'sessionId'),
  toRef(props, 'activeTab'),
)
/**
 * ESC 关闭抽屉（panel/spec.md：抽屉是浮层，ESC 收起）。
 * 仅在 isOpen 时挂监听，避免抽屉关闭后仍抢全局 keydown（如 composer 输入态）。
 * 单实例安全：SideDrawer 由 PanelContainer 单实例挂载（见 PanelContainer.vue 注释「drawer 固定挂本容器，单实例」），
 * split/overlay 模式切换不创建第二个实例，故实例级 onKeyDown 不会重复注册（规则 2）。
 * 若未来支持多 SideDrawer 实例，需改为模块级 refCount 栈保护。
 */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}
watch(
  () => props.isOpen,
  (open) => {
    if (open) window.addEventListener('keydown', onKeyDown)
    else window.removeEventListener('keydown', onKeyDown)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<style scoped>
/* 抽屉淡入/淡出（panel/spec.md v2）。
   v2：单 panel 恒 split 模式（drawer 是 flex 子项），仅保留 drawer-slide-right。
   内容 opacity 淡入足够柔和（布局瞬时切换配合 opacity 淡入）。
   escape hatch：Vue Transition 类无法用 Tailwind 表达（需 enter-from/leave-to 同时设 opacity）。 */
.drawer-slide-right-enter-from,
.drawer-slide-right-leave-to {
  opacity: 0;
}
.drawer-slide-right-enter-active,
.drawer-slide-right-leave-active {
  transition: opacity var(--duration-slow) var(--ease);
}
</style>
