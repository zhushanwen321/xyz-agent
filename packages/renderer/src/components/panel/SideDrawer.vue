<!--
  SideDrawer —— workspace-body 级辅助视图容器，承载 Terminal/Browser/Git/Doc/Detail 五个 tab。
  Terminal/Browser 走 widget 订阅；Git tab 由 GitPanel.vue inject git 状态；Doc/Detail 各自独立。

  形态（双模式，由 props.mode 决定，PanelContainer 按 panel.isDual 派生）：
  · split（单 panel）：drawer 是 PanelContainer 的 flex 子项，与 Panel 各 flex-1 均分，并排占 workspace 一半；
  · overlay（双 panel）：drawer 是 absolute 浮层（w-1/2、z-30），覆盖对侧 standby panel——
    dual 时两个 panel 已占满 workspace，drawer 只能盖掉一个。
  方向（props.direction，由 host panel 位置决定）：host=P1 → drawer 贴右（direction='right'）；host=P2 → 贴左。
  split 模式下 direction 决定边框方向 + order（单 panel 恒 right，order 仅作防御）。

  状态控制走 useSideDrawer（§6.3 点5 架构解耦）：本组件只接收 isOpen/activeTab/docked/direction/mode
  props + emit close/set-tab/toggle-dock，不持有状态。widget 订阅（#11 W3a）在本组件按 props.sessionId
  接入 useSessionEvents.onMessage，按 widgetKey 路由到 terminal/browser tab。
  Git tab 不走 widget——数据由 PanelContainer 经 GIT_STATUS_KEY provide，GitPanel 自行 inject，
  本通用容器不持有 git props（保持容器纯净，不污染通用 tab 范式）。
-->
<template>
  <Transition :name="direction === 'left' ? 'drawer-slide-left' : 'drawer-slide-right'">
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
            :class="activeTab === t.key ? 'bg-accent-soft text-accent' : 'text-muted'"
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
          :class="docked ? 'text-accent' : 'text-subtle'"
          :title="docked ? t('panel.sideDrawer.unpin') : t('panel.sideDrawer.pin')"
          @click="emit('toggle-dock')"
        >
          <PinOff v-if="docked" class="size-3" />
          <Pin v-else class="size-3" />
        </Button>
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-subtle hover:text-fg"
          :title="t('panel.sideDrawer.close')"
          @click="emit('close')"
        >
          <X class="size-3" />
        </Button>
      </header>

      <!-- 内容区：Git / Terminal / Browser。
           Git tab → GitPanel（inject GIT_STATUS_KEY，自取 git 全量状态；非 git 仓库组件内自隐藏走空态）。
           Terminal/Browser → widget 订阅（#11 W3a），按 widgetKey 路由（mapWidgetKeyToTab），
           未匹配 widgetKey 走 fallback。空态：widget 未推送或 session 未连接。 -->
      <div class="min-h-0 flex-1 overflow-auto">
        <!-- Git tab：全量 git 状态 + 暂存/提交（非 git 仓库 GitPanel 内自隐藏，此处显空态） -->
        <GitPanel v-if="activeTab === 'git'" />
        <!-- Doc tab：命令/skill 详细文档（selectedCommandName 指定，CommandDocPanel 内自取 commandStore + skills） -->
        <CommandDocPanel v-else-if="activeTab === 'doc'" :session-id="sessionId" />
        <!-- Detail tab：文件预览（#6，useDetailPane watch selectedPath 自动加载，禁 v-html） -->
        <DetailPane v-else-if="activeTab === 'detail'" :session-id="sessionId" />
        <!-- Tasks tab：goal 卡片 + todo 列表（tasks store 按 sessionId 分区，只读渲染） -->
        <TasksPanel v-else-if="activeTab === 'tasks'" :session-id="sessionId" />
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
            class="mb-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted"
          >
            {{ t('panel.sideDrawer.unknownWidget') }}：{{ activeLinesMeta.key }}
          </div>
          <code
            v-for="(line, i) in activeLines"
            :key="i"
            class="block whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.45] text-fg/90"
            >{{ line }}</code
          >
        </div>
        <!-- active tab 无 widget 内容 → 空态占位 -->
        <div
          v-else
          class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
        >
          <component :is="activeTabMeta.icon" class="size-6 text-subtle opacity-40" />
          <p class="text-[12px] text-subtle opacity-70">{{ activeTabMeta.emptyText }}</p>
          <p class="text-[11px] text-subtle opacity-50">{{ activeTabMeta.emptyHint }}</p>
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
          <span class="shrink-0 text-subtle">{{ entry.statusKey }}</span>
          <!-- textRaw 有 ANSI 着色 → AnsiText 渲染保留颜色；否则纯文本兜底。
               容器承载 truncate（min-w-0 + overflow-hidden + ellipsis），避免与 AnsiText 内部 whitespace-pre-wrap 冲突。 -->
          <div v-if="entry.textRaw" class="min-w-0 flex-1 overflow-hidden">
            <AnsiText :content="entry.textRaw" class="block truncate text-muted" />
          </div>
          <span v-else class="min-w-0 flex-1 truncate text-muted">{{ entry.text }}</span>
        </div>
      </footer>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import { Terminal as TerminalIcon, Globe, GitBranch, BookOpen, FileText, Pin, PinOff, X, CheckSquare } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import GitPanel from './GitPanel.vue'
import CommandDocPanel from './CommandDocPanel.vue'
import DetailPane from './DetailPane.vue'
import TasksPanel from './TasksPanel.vue'
import GuiComponentRenderer from './message-stream/GuiComponentRenderer.vue'
import AnsiText from './message-stream/gui/AnsiText.vue'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'
import { useDrawerWidgets } from '@/composables/features/useDrawerWidgets'
import { useTasksStore } from '@/stores/tasks'

const props = defineProps<{
  isOpen: boolean
  activeTab: SideDrawerTab
  docked: boolean
  /** 抽屉贴边方向（panel/spec.md v2）：host=P1→'right'（贴右），host=P2→'left'（贴左） */
  direction: 'right' | 'left'
  /**
   * 布局模式（PanelContainer 按 panel.isDual 派生）：
   * · 'split'（单 panel）：flex 子项，与 Panel 各占一半，并排不覆盖；
   * · 'overlay'（双 panel）：absolute 浮层覆盖对侧 standby panel。
   */
  mode: 'split' | 'overlay'
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

/**
 * aside 容器 class（按 mode 切换定位策略）：
 * · overlay（双 panel）：absolute 浮层覆盖对侧——与原 v2 形态逐字一致，dual 行为零回归；
 * · split（单 panel）：flex 子项 flex-1，与 Panel 的 flex-1 各占 50% 并排，不覆盖。
 * direction 在 split 下决定边框方向 + order（单 panel 恒 right，order-first 仅防御性）。
 */
const asideClass = computed<string[]>(() => {
  const borderLeft = 'border-l border-border-strong'
  const borderRight = 'border-r border-border-strong'
  if (props.mode === 'overlay') {
    // overlay（双 panel）：absolute 浮层覆盖对侧 standby panel，用 bg-elevated 表达浮起感
    return [
      'flex h-full flex-col bg-bg-elevated',
      'absolute top-0 z-30 w-1/2 shadow-2xl',
      props.direction === 'left' ? `left-0 ${borderRight}` : `right-0 ${borderLeft}`,
    ]
  }
  // split（单 panel）：flex 子项，与 Panel 各占一半。底色用 bg-surface（与 Panel 内容区一致，
  // 不浮起——此时 Panel section 透明继承 MainPanel 的 surface，drawer 同色与之并列为 main 内容区）
  return [
    'flex h-full flex-col bg-surface',
    'relative min-w-0 flex-1',
    props.direction === 'left' ? `order-first ${borderRight}` : borderLeft,
  ]
})

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

/** widget/status 缓冲与 extension 事件订阅（含 ExtensionRegistry 对 goal/todo 等已知
 *  extension 的分流）抽到 useDrawerWidgets composable，本组件只消费其暴露的响应式状态。 */
const { activeGuiComponent, activeLines, activeLinesMeta, statusEntries } = useDrawerWidgets(
  toRef(props, 'sessionId'),
  toRef(props, 'activeTab'),
)

/**
 * ESC 关闭抽屉（panel/spec.md：抽屉是浮层，ESC 收起）。
 * 仅在 isOpen 时挂监听，避免抽屉关闭后仍抢全局 keydown（如 composer 输入态）。
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
   原 translateX 位移动画被 PanelContainer 的 overflow-hidden 裁掉（overlay 模式下 drawer 是 absolute 子元素，
   溢出定位容器必须被裁以防止关闭按钮飘出窗口），改为纯 opacity 淡入淡出。
   split 模式下 drawer 是 flex 子项不受 overflow-hidden 影响，但布局瞬时切换（Panel 宽度 100%↔50%）配合
   内容 opacity 淡入已足够柔和，两种模式共用同一组 transition 类。
   escape hatch：Vue Transition 类无法用 Tailwind 表达（需 enter-from/leave-to 同时设 opacity）。 */
.drawer-slide-right-enter-from,
.drawer-slide-right-leave-to,
.drawer-slide-left-enter-from,
.drawer-slide-left-leave-to {
  opacity: 0;
}
.drawer-slide-right-enter-active,
.drawer-slide-right-leave-active,
.drawer-slide-left-enter-active,
.drawer-slide-left-leave-active {
  transition: opacity var(--duration-slow) var(--ease);
}
</style>
