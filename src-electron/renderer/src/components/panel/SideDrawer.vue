<!--
  SideDrawer —— workspace-body 级抽屉（panel/spec.md §未决项#1 v2 形态裁决 / draft-detail-pane.html）。
  Terminal/Browser/Git 三 tab（§6.3 点2）。Git tab 承载全量 git 状态（GitPanel.vue），
  Terminal/Browser 走 widget 订阅。

  形态（v2 裁决：占另一半）—— drawer 是 PanelContainer（workspace-body）的 absolute 浮层，
  width:50%，覆盖 workspace 的另一半空间，不参与 panel 的 flex 均分布局（panel 始终 flex-1 撑满/均分）：
  · 单 panel：drawer 覆盖 workspace 右（或左）半；
  · 双 panel：drawer 覆盖对侧 standby panel。
  方向：host=P1 → drawer 贴右（direction='right'）；host=P2 → drawer 贴左（direction='left'）。

  状态控制走 useSideDrawer（§6.3 点5 架构解耦）：本组件只接收 isOpen/activeTab/docked/direction props
  + emit close/set-tab/toggle-dock，不持有状态。widget 订阅（#11 W3a）在本组件按 props.sessionId
  接入 extension.onWidget，按 widgetKey 路由到 terminal/browser tab。
  Git tab 不走 widget——数据由 PanelContainer 经 GIT_STATUS_KEY provide，GitPanel 自行 inject，
  本通用容器不持有 git props（保持容器纯净，不污染通用 tab 范式）。
-->
<template>
  <Transition :name="direction === 'left' ? 'drawer-slide-left' : 'drawer-slide-right'">
    <aside
      v-if="isOpen"
      class="absolute top-0 z-30 flex h-full w-1/2 flex-col bg-bg-elevated shadow-2xl"
      :class="direction === 'left' ? 'left-0 border-r border-border-strong' : 'right-0 border-l border-border-strong'"
      aria-label="侧边抽屉"
    >
      <!-- header：tab 栏（左）+ 钉住/关闭（右） -->
      <header class="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div class="flex flex-1 gap-0.5">
          <Button
            v-for="t in tabs"
            :key="t.key"
            variant="ghost"
            class="h-7 gap-1 rounded-sm px-2 text-[12px]"
            :class="activeTab === t.key ? 'bg-accent-soft text-accent' : 'text-muted'"
            :title="t.label"
            @click="emit('set-tab', t.key)"
          >
            <component :is="t.icon" class="size-3" />
            {{ t.label }}
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
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Component } from 'vue'
import { Terminal as TerminalIcon, Globe, GitBranch, BookOpen, FileText, Pin, PinOff, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import GitPanel from './GitPanel.vue'
import CommandDocPanel from './CommandDocPanel.vue'
import DetailPane from './DetailPane.vue'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'
import { extension } from '@/api'

const props = defineProps<{
  isOpen: boolean
  activeTab: SideDrawerTab
  docked: boolean
  /** 抽屉贴边方向（panel/spec.md v2）：host=P1→'right'（贴右），host=P2→'left'（贴左） */
  direction: 'right' | 'left'
  /** widget 订阅的 session 标识（#11 W3a）：为 null 不订阅 */
  sessionId: string | null
}>()

const emit = defineEmits<{
  close: []
  'set-tab': [tab: SideDrawerTab]
  'toggle-dock': []
}>()

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

let unsubWidget: (() => void) | null = null
let unsubStatus: (() => void) | null = null

/** extension status 缓冲：statusKey → 最新 text（runtime 推送全量替换，与 widget 同语义） */
const statusMap = ref<Map<string, string>>(new Map())
const statusEntries = computed(() =>
  Array.from(statusMap.value.entries()).map(([statusKey, text]) => ({ statusKey, text })),
)

function subscribeWidget(sid: string): void {
  terminalLines.value = []
  browserLines.value = []
  unknownWidget.value = null
  statusMap.value = new Map()
  // 签名已与 real extension.ts OnWidgetHandler 对齐（mock 侧同步修复），facade 不再退化为 unknown
  unsubWidget = extension.onWidget(sid, (payload) => {
    const tab = mapWidgetKeyToTab(payload.widgetKey)
    if (tab === 'terminal') terminalLines.value = payload.lines
    else if (tab === 'browser') browserLines.value = payload.lines
    else unknownWidget.value = { key: payload.widgetKey, lines: payload.lines }
  })
  // 对称订阅 extension:status（statusKey 维度聚合，同 key 覆盖）
  unsubStatus = extension.onStatus(sid, (payload) => {
    statusMap.value.set(payload.statusKey, payload.text)
    statusMap.value = new Map(statusMap.value)
  })
}

watch(
  () => props.sessionId,
  (sid) => {
    unsubWidget?.()
    unsubStatus?.()
    unsubWidget = null
    unsubStatus = null
    if (sid) subscribeWidget(sid)
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
  unsubWidget?.()
  unsubStatus?.()
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<style scoped>
/* 抽屉滑入/滑出（panel/spec.md v2：dir-right 从右滑出 translateX(100%)，dir-left 从左滑出 translateX(-100%)）。
   escape hatch：Vue Transition 类无法用 Tailwind 表达（需 enter-from/leave-to 同时变换）。 */
.drawer-slide-right-enter-from,
.drawer-slide-right-leave-to,
.drawer-slide-left-enter-from,
.drawer-slide-left-leave-to {
  opacity: 0;
}
.drawer-slide-right-enter-from,
.drawer-slide-right-leave-to {
  transform: translateX(100%);
}
.drawer-slide-left-enter-from,
.drawer-slide-left-leave-to {
  transform: translateX(-100%);
}
.drawer-slide-right-enter-active,
.drawer-slide-right-leave-active,
.drawer-slide-left-enter-active,
.drawer-slide-left-leave-active {
  transition:
    transform var(--duration-slow) var(--ease),
    opacity var(--duration-slow) var(--ease);
}
</style>
