<script setup lang="ts">
/**
 * WidgetArea（M17）—— 对话流 widget 面板（v6-plugin-max-demo M17 区块）。
 *
 * 消费 ViewHostStore 的 per-session widget 缓存（经注入 ViewHostSource）：
 * getViewIds 枚举该 session 全部 viewId（widgetKey），逐个 getView 拼装多卡视图，
 * 每卡卡头渲染 widgetKey 标签 + 折叠开关，卡体交 GuiComponentRenderer 渲染 guiTree。
 * 常驻语义：extension 推 extension:widget/widgetGui 即缓存（同 key 覆盖更新），
 * gui:null 清除后条目消失（entries 为空时整体零 DOM，不残留空容器）。
 *
 * 宽度对齐 composer：外层 band px-5（同 composer-band），内层 grid
 * mx-auto max-w-[var(--content-max-w)]（同 Composer）——单卡/多卡联合宽度恒 ≤ composer。
 *
 * 数据源经 inject 注入（VIEW_HOST_SOURCE_KEY），壳层 provide 真实实现，单测
 * global.provide mock；无注入时静默空态不崩（inject(key, null) 兜底）。
 */
import { computed, inject, ref } from 'vue'
import { VIEW_HOST_SOURCE_KEY } from '../../extension-host'
import type { ViewCacheEntry } from '../../extension-host'
import GuiComponentRenderer from '../../rendering-protocol/GuiComponentRenderer.vue'

const props = defineProps<{
  /** 所属 session */
  sessionId: string
}>()

const source = inject(VIEW_HOST_SOURCE_KEY, null)

/** 单张 widget 卡的装配结果（viewId + 命中的缓存条目）。 */
interface WidgetEntry {
  viewId: string
  entry: ViewCacheEntry
}

/**
 * 该 session 全部可渲染 widget 卡。
 *
 * getViewIds 与 getView 必须都在本 computed 内调用：壳层 reactive 桥的依赖追踪
 * 靠调用路径触碰 reactive Map（分区后建 trigger + partition keys 迭代追踪），
 * 拆到 computed 外会断链 → widget 推送后不重算。过滤 entry 缺失或 guiTree 空的
 * 条目（gui:null 清除语义 + 异常 payload 防护，不出空卡）。
 */
const entries = computed<WidgetEntry[]>(() => {
  if (!source) return []
  return source
    .getViewIds(props.sessionId)
    .map((viewId) => ({ viewId, entry: source.getView(props.sessionId, viewId) }))
    .filter((e): e is WidgetEntry => e.entry !== undefined && e.entry.guiTree.length > 0)
})

/** 已收起的 viewId 集合（纯 UI 偏好，跨推送/跨 session 保留；ref 包装的 Set 被 Vue 深层 reactive 化，add/delete 可追踪）。 */
const collapsed = ref(new Set<string>())

function toggleCollapsed(viewId: string): void {
  if (collapsed.value.has(viewId)) collapsed.value.delete(viewId)
  else collapsed.value.add(viewId)
}
</script>

<template>
  <!-- 外层 band：px-5 对齐 composer-band 侧距；内层 grid 才是卡片容器（宽度对齐 Composer） -->
  <div v-if="entries.length > 0" data-testid="widget-area" class="flex-shrink-0 px-5 py-2">
    <div
      data-testid="widget-area-grid"
      class="mx-auto flex w-full max-w-[var(--content-max-w)] flex-wrap items-stretch gap-2.5"
    >
      <!-- 卡壳对齐 Card 原语（rendering-protocol/primitives/Card.vue 的 v6 裁决）：无 border
           靠 bg 层级分组、rounded-md(8px)。goal 有预算 widget 顶层即 card 原语，壳若带
           border/更大圆角会内外双层卡（卡中卡）且圆角差混尺寸 -->
      <div
        v-for="w in entries"
        :key="w.viewId"
        data-testid="widget-card"
        :data-collapsed="collapsed.has(w.viewId)"
        class="flex min-w-0 flex-col gap-1.5 rounded-md bg-surface p-3"
        :class="collapsed.has(w.viewId) ? 'flex-none self-start' : 'flex-1 basis-60 self-stretch'"
      >
        <!-- 卡头：widgetKey 标签（mono 9px，对齐 demo M17 tool-label 规格）+ 折叠开关。
             点击整行切换；chevron 展开态旋转 90° 下指（对齐 TraceCompactorRow 范式） -->
        <div
          data-testid="widget-card-header"
          class="flex cursor-pointer select-none items-center justify-between gap-2 text-neutral-dim transition-colors hover:text-neutral-fg"
          @click="toggleCollapsed(w.viewId)"
        >
          <span class="font-mono text-[9px] tracking-wider">{{ w.viewId }}</span>
          <svg
            class="size-3 shrink-0 transition-transform"
            :class="collapsed.has(w.viewId) ? '' : 'rotate-90'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </div>
        <!-- 卡体：guiTree 逐项交渲染协议。max-h 钳制防长列表 widget 撑高面板挤出
             composer（Panel section overflow-hidden 会直接裁剪，常驻语义放大该风险）；
             index key 的前提是 7 原语均 props-only 无内部状态，原语引入本地状态时需改稳定 key。
             v-show 保折叠切换不重挂原语树 -->
        <div
          v-show="!collapsed.has(w.viewId)"
          data-testid="widget-card-body"
          class="flex max-h-64 min-h-0 flex-col gap-1.5 overflow-y-auto"
        >
          <GuiComponentRenderer
            v-for="(component, i) in w.entry.guiTree"
            :key="i"
            :component="component"
          />
        </div>
      </div>
    </div>
  </div>
</template>
