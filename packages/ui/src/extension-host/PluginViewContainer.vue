<script setup lang="ts">
/**
 * PluginViewContainer（W4 · T3）——sidebar plugins tab 的 L2 二级路由容器。
 *
 * 数据流：inject VIEWS_SOURCE_KEY（壳 provide，ContributionRegistry sidebar.tab
 * 视图贡献）→ computed views → L2TabBar 渲染二级 tab + ViewHost 按 activeViewId
 * 渲染对应 view 的 GuiComponent 树（ViewHostStore 缓存）。
 *
 * 本地状态（design T3 约束，均不持久化）：
 * - activeViewId：切 tab 只改它；默认 = 第一个可见（未关闭）view
 * - closedViewIds：close 事件对 non-builtin 生效（本地 ref 移除，不持久化）
 * - pinnedViewIds：pin 事件切换本地 ref
 *
 * builtin 判定：view.pluginId === 'tasks'（与 core builtin-contributions.ts 的
 * tasks plugin 声明对齐）→ 不可关闭（L2TabBar 不渲染 close 按钮，容器侧再守卫）。
 *
 * icon 字典：viewId 匹配（todo→ListTodo、goal→Target）；view.icon 提供时优先按
 * icon 名查同一字典；均未命中 → 默认 LayoutGrid。
 *
 * 无注入 source / 无 views：静默空态不崩（对齐 ViewHost 的 inject null 语义）。
 */
import { computed, inject, ref } from 'vue'
import type { Component } from 'vue'
import { LayoutGrid, ListTodo, Target } from '@lucide/vue'
import { VIEWS_SOURCE_KEY, type PluginViewSummary } from './views-source'
import L2TabBar from './L2TabBar.vue'
import type { L2TabItem } from './l2-tab-item'
import ViewHost from './ViewHost.vue'

const props = defineProps<{
  /** 透传给 ViewHost 的 sessionId（view GuiComponent 树按 session 分区） */
  sessionId: string
}>()

const source = inject(VIEWS_SOURCE_KEY, null)

/** builtin plugin（core builtin-contributions.ts 声明）——不可关闭 */
const BUILTIN_PLUGIN_IDS = new Set(['tasks'])

/** icon 内置字典：viewId/icon 名 → lucide 组件（R3 动态组件机制） */
const ICON_BY_KEY: Record<string, Component> = {
  todo: ListTodo,
  goal: Target,
}

const DEFAULT_ICON: Component = LayoutGrid

/** 全部贡献 view（无 source 注入 → 空数组，静默空态） */
const views = computed<PluginViewSummary[]>(() => source?.getViews() ?? [])

// ── 本地状态（close/pin 不持久化，design T2/T3 约束）──
const activeViewId = ref<string | null>(null)
const closedViewIds = ref<Set<string>>(new Set())
const pinnedViewIds = ref<Set<string>>(new Set())

/** 可见 views（排除本地 close 的） */
const visibleViews = computed<PluginViewSummary[]>(() =>
  views.value.filter((v) => !closedViewIds.value.has(v.viewId)),
)

/** L2 二级 tab 数据（icon 字典解析 + builtin/pinned 标记） */
const tabs = computed<L2TabItem[]>(() =>
  visibleViews.value.map((v) => ({
    viewId: v.viewId,
    title: v.title,
    icon: resolveIcon(v),
    pinned: pinnedViewIds.value.has(v.viewId),
    builtin: BUILTIN_PLUGIN_IDS.has(v.pluginId),
  })),
)

/** 当前 active view（本地切换；缺省/失效回退第一个可见 view） */
const activeView = computed<string | null>(() => {
  if (activeViewId.value && visibleViews.value.some((v) => v.viewId === activeViewId.value)) {
    return activeViewId.value
  }
  return visibleViews.value[0]?.viewId ?? null
})

const activeTitle = computed<string | undefined>(() =>
  visibleViews.value.find((v) => v.viewId === activeView.value)?.title,
)

/** icon 解析：icon 名优先 → viewId 兜底 → 默认图标 */
function resolveIcon(view: PluginViewSummary): Component {
  if (view.icon) {
    const byName = ICON_BY_KEY[view.icon]
    if (byName) return byName
  }
  return ICON_BY_KEY[view.viewId] ?? DEFAULT_ICON
}

function onSelect(viewId: string): void {
  activeViewId.value = viewId
}

function onClose(viewId: string): void {
  const view = views.value.find((v) => v.viewId === viewId)
  // 守卫：builtin 不可关闭（L2TabBar 已不渲染其 close 按钮，双保险）
  if (!view || BUILTIN_PLUGIN_IDS.has(view.pluginId)) return
  closedViewIds.value.add(viewId)
  // 关闭当前 active 时回退由 activeView computed 自动落到下一个可见 view
  if (activeViewId.value === viewId) activeViewId.value = null
}

function onPin(viewId: string): void {
  const next = new Set(pinnedViewIds.value)
  if (next.has(viewId)) next.delete(viewId)
  else next.add(viewId)
  pinnedViewIds.value = next
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-1 p-1">
    <template v-if="tabs.length > 0">
      <L2TabBar
        :tabs="tabs"
        :model-value="activeView ?? ''"
        @update:model-value="onSelect"
        @close="onClose"
        @pin="onPin"
      />
      <ViewHost
        v-if="activeView"
        :view-id="activeView"
        :session-id="props.sessionId"
        :title="activeTitle"
        empty="placeholder"
      />
    </template>
    <!-- 无 tabs（无 source 注入 / 无贡献 view）→ 空态提示，不崩（inject null 语义） -->
    <div
      v-else
      data-testid="plugin-view-empty"
      class="flex flex-col items-center justify-center gap-2 py-10 text-center"
    >
      <LayoutGrid class="size-5 text-neutral-dim opacity-40" />
      <p class="text-[11px] text-neutral-dim opacity-55">暂无插件视图</p>
    </div>
  </div>
</template>
