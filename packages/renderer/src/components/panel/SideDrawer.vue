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
  接入 extension.onWidget，按 widgetKey 路由到 terminal/browser tab。
  Git tab 不走 widget——数据由 PanelContainer 经 GIT_STATUS_KEY provide，GitPanel 自行 inject，
  本通用容器不持有 git props（保持容器纯净，不污染通用 tab 范式）。
-->
<template>
  <Transition :name="direction === 'left' ? 'drawer-slide-left' : 'drawer-slide-right'">
    <aside
      v-if="isOpen"
      :class="asideClass"
      aria-label="侧边抽屉"
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
            @click="emit('set-tab', t.key)"
          >
            <component :is="t.icon" class="size-3.5" />
          </Button>
        </div>

        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0"
          :class="docked ? 'text-accent' : 'text-subtle'"
          :title="docked ? '取消钉住' : '钉住'"
          @click="emit('toggle-dock')"
        >
          <PinOff v-if="docked" class="size-3" />
          <Pin v-else class="size-3" />
        </Button>
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-subtle hover:text-fg"
          title="关闭"
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
            未识别 widget：{{ activeLinesMeta.key }}
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
          class="flex items-center gap-1.5 font-mono text-[10.5px]"
        >
          <span class="text-subtle">{{ entry.statusKey }}</span>
          <span class="truncate text-muted">{{ entry.text }}</span>
        </div>
      </footer>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue'
import type { Component } from 'vue'
import { Terminal as TerminalIcon, Globe, GitBranch, BookOpen, FileText, Pin, PinOff, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import GitPanel from './GitPanel.vue'
import CommandDocPanel from './CommandDocPanel.vue'
import DetailPane from './DetailPane.vue'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'
import { useSessionEvents } from '@/composables/features/useSessionEvents'

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

/**
 * aside 容器 class（按 mode 切换定位策略）：
 * · overlay（双 panel）：absolute 浮层覆盖对侧——与原 v2 形态逐字一致，dual 行为零回归；
 * · split（单 panel）：flex 子项 flex-1，与 Panel 的 flex-1 各占 50% 并排，不覆盖。
 * direction 在 split 下决定边框方向 + order（单 panel 恒 right，order-first 仅防御性）。
 */
const asideClass = computed<string[]>(() => {
  const base = 'flex h-full flex-col bg-bg-elevated'
  const borderLeft = 'border-l border-border-strong'
  const borderRight = 'border-r border-border-strong'
  if (props.mode === 'overlay') {
    return [
      base,
      'absolute top-0 z-30 w-1/2 shadow-2xl',
      props.direction === 'left' ? `left-0 ${borderRight}` : `right-0 ${borderLeft}`,
    ]
  }
  // split：flex 子项，与 Panel 各占一半
  return [
    base,
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

/** tab 元信息（§6.3 点2：Terminal/Browser/Git）。Git tab 内容为 GitPanel（inject 数据）。 */
const tabs: TabMeta[] = [
  {
    key: 'terminal',
    label: 'Terminal',
    icon: TerminalIcon,
    emptyText: '暂无终端输出',
    emptyHint: 'extension 推送 terminal widget 后显示实时输出',
  },
  {
    key: 'browser',
    label: 'Browser',
    icon: Globe,
    emptyText: '暂无浏览器预览',
    emptyHint: 'extension 推送 browser widget 后显示预览',
  },
  {
    key: 'git',
    label: 'Git',
    icon: GitBranch,
    emptyText: '当前目录非 git 仓库',
    emptyHint: '在 git 仓库内打开 session 后可查看状态并暂存/提交',
  },
  {
    key: 'doc',
    label: 'Doc',
    icon: BookOpen,
    emptyText: '未选择命令',
    emptyHint: '点击用户气泡中的命令 chip 查看命令/skill 文档',
  },
  {
    key: 'detail',
    label: 'Detail',
    icon: FileText,
    emptyText: '未选择文件',
    emptyHint: '点击侧栏文件树中的文件预览内容',
  },
]

const activeTabMeta = computed(() => tabs.find((t) => t.key === props.activeTab) ?? tabs[0])

/** widget 缓冲：按 tab 存最新 lines（runtime 每次推全量，见 extension.onWidget）。 */
const terminalLines = ref<string[]>([])
const browserLines = ref<string[]>([])
/** 未匹配 tab 的 widgetKey fallback：存最后一个未知 widget 的 {key, lines}，默认路由到 terminal 显示 */
const unknownWidget = ref<{ key: string; lines: string[] } | null>(null)

const activeLines = computed<string[]>(() => {
  if (props.activeTab === 'browser') return browserLines.value
  return terminalLines.value.length ? terminalLines.value : unknownWidget.value?.lines ?? []
})

/** active 内容的元信息（用于 fallback 标记） */
const activeLinesMeta = computed(() => {
  if (props.activeTab === 'browser') return { unknown: false, key: '' }
  if (terminalLines.value.length) return { unknown: false, key: '' }
  if (unknownWidget.value) return { unknown: true, key: unknownWidget.value.key }
  return { unknown: false, key: '' }
})

/**
 * widgetKey → tab 路由启发式（NFR Prototype 1 枚举对齐前的过渡方案）。
 * runtime 推送的 widgetKey 为 extension 自定义字符串，归一化后匹配常见关键词。
 * 未命中 → null（调用方走 fallback）。
 */
function mapWidgetKeyToTab(key: string): SideDrawerTab | null {
  const k = key.toLowerCase()
  if (k.includes('terminal') || k.includes('shell') || k.includes('console') || k.includes('bash')) {
    return 'terminal'
  }
  if (k.includes('browser') || k === 'web' || k.startsWith('webview') || k.includes('preview')) {
    return 'browser'
  }
  return null
}

/** extension status 缓冲：statusKey → 最新 text（runtime 推送全量替换，与 widget 同语义） */
const statusMap = ref<Map<string, string>>(new Map())
const statusEntries = computed(() =>
  Array.from(statusMap.value.entries()).map(([statusKey, text]) => ({ statusKey, text })),
)

/** widget 缓冲行数上限（NFR Issue #11 性能：前端最多保留 1000 行，超出截断保留尾部最新） */
const WIDGET_MAX_LINES = 1000

/** 保留最新尾部 WIDGET_MAX_LINES 行（前端缓冲上限，对齐原 extension.onWidget 截断语义） */
function truncateLines(lines: string[]): string[] {
  if (lines.length <= WIDGET_MAX_LINES) return lines
  return lines.slice(lines.length - WIDGET_MAX_LINES)
}

/**
 * widget/status 订阅编排（#11 W3a）：订阅时机、sessionId 切换重订、卸载退订归 useSessionEvents
 * （features 层，session 通道）。本组件只保留 widget 缓冲逻辑（tab 路由 + lines 截断 + status 聚合）。
 *
 * sessionId 变化时清空缓冲（与原 watch 行为等价：terminalLines/browserLines/unknownWidget/statusMap 复位），
 * 由下方 watch(sessionId) 负责；本处 handler 只处理消息分发。
 */
const onMessage = useSessionEvents(toRef(props, 'sessionId'))
// extension:widget：按 widgetKey 路由到 terminal/browser tab，未匹配走 fallback
onMessage('extension:widget', (msg) => {
  const payload = msg.payload
  const lines = truncateLines(payload.lines)
  const tab = mapWidgetKeyToTab(payload.widgetKey)
  if (tab === 'terminal') terminalLines.value = lines
  else if (tab === 'browser') browserLines.value = lines
  else unknownWidget.value = { key: payload.widgetKey, lines }
})
// extension:status：statusKey 维度聚合，同 key 覆盖（与原 extension.onStatus 对称语义）
onMessage('extension:status', (msg) => {
  const payload = msg.payload
  statusMap.value.set(payload.statusKey, payload.text)
  statusMap.value = new Map(statusMap.value)
})

// sessionId 变化时清空缓冲（useSessionEvents 已负责底层订阅重订，这里只复位组件缓冲状态）
watch(
  () => props.sessionId,
  () => {
    terminalLines.value = []
    browserLines.value = []
    unknownWidget.value = null
    statusMap.value = new Map()
  },
  { immediate: true },
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
