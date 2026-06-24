<!--
  SideDrawer —— 右抽屉容器（issues.md #9 / code-architecture §4.10 / panel/spec.md）。
  Terminal/Browser 两 tab（§6.3 点2，不含 Diff——Diff 审批 Out-of-scope，见 spec FR-8）。
  与 Panel 数据强耦合，固定挂触发 Panel（panel/spec.md），由 Panel.vue 渲染为 section 内 absolute 浮层。

  状态控制走 useSideDrawer（§6.3 点5 架构解耦）：本组件只接收 isOpen/activeTab/docked props
  + emit close/set-tab/toggle-dock，不持有状态。widget 订阅（#11 W3a）在本组件按 props.sessionId
  接入 extension.onWidget，按 widgetKey 路由到 terminal/browser tab。
-->
<template>
  <Transition name="drawer-slide">
    <aside
      v-if="isOpen"
      class="absolute right-0 top-0 z-30 flex h-full w-[340px] flex-col border-l border-border-strong bg-bg-elevated shadow-2xl"
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

      <!-- 内容区：Terminal / Browser（widget 订阅 #11 W3a）。
           按 widgetKey 路由到 tab（mapWidgetKeyToTab）；未匹配 widgetKey 走 fallback。
           空态：widget 未推送或 session 未连接。 -->
      <div class="min-h-0 flex-1 overflow-auto">
        <!-- active tab 有 widget 内容 → 渲染等宽文本输出（每行一个 div，font-mono + pre-wrap） -->
        <div
          v-if="activeLines.length"
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
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Component } from 'vue'
import { Terminal as TerminalIcon, Globe, Pin, PinOff, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { SideDrawerTab } from '@/composables/features/useSideDrawer'
import { extension } from '@/api'

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

interface TabMeta {
  key: SideDrawerTab
  label: string
  icon: Component
  emptyText: string
  emptyHint: string
}

/** tab 元信息（§6.3 点2：Terminal/Browser，不含 Diff） */
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

function subscribeWidget(sid: string): void {
  terminalLines.value = []
  browserLines.value = []
  unknownWidget.value = null
  // 签名已与 real extension.ts OnWidgetHandler 对齐（mock 侧同步修复），facade 不再退化为 unknown
  unsubWidget = extension.onWidget(sid, (payload) => {
    const tab = mapWidgetKeyToTab(payload.widgetKey)
    if (tab === 'terminal') terminalLines.value = payload.lines
    else if (tab === 'browser') browserLines.value = payload.lines
    else unknownWidget.value = { key: payload.widgetKey, lines: payload.lines }
  })
}

watch(
  () => props.sessionId,
  (sid) => {
    unsubWidget?.()
    unsubWidget = null
    if (sid) subscribeWidget(sid)
  },
  { immediate: true },
)

onBeforeUnmount(() => unsubWidget?.())
</script>

<style scoped>
/* 抽屉从右滑入/滑出（panel/spec.md 右抽屉从右滑出）。
   escape hatch：Vue Transition 类无法用 Tailwind 表达（需 enter-from/leave-to 同时变换）。 */
.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition:
    transform var(--duration-slow) var(--ease),
    opacity var(--duration-slow) var(--ease);
}
</style>
