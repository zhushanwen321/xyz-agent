<script setup lang="ts">
/**
 * WidgetArea（M17）—— 对话流 widget 面板（v6-plugin-max-demo M17 区块）。
 *
 * 消费 ViewHostStore 的 per-session widget 缓存（经注入 ViewHostSource）：
 * getViewIds 枚举该 session 全部 viewId（widgetKey），逐个 getView 拼装多卡视图，
 * 每卡卡头渲染 widgetKey 标签，卡体交 GuiComponentRenderer 渲染 guiTree。
 * 常驻语义：extension 推 extension:widget/widgetGui 即缓存（同 key 覆盖更新），
 * gui:null 清除后条目消失（entries 为空时整体零 DOM，不残留空容器）。
 *
 * 数据源经 inject 注入（VIEW_HOST_SOURCE_KEY），壳 provide 真实实现，单测
 * global.provide mock；无注入时静默空态不崩（inject(key, null) 兜底）。
 */
import { computed, inject } from 'vue'
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
</script>

<template>
  <div
    v-if="entries.length > 0"
    data-testid="widget-area"
    class="flex flex-shrink-0 flex-wrap items-stretch gap-2.5 px-5 py-2"
  >
    <div
      v-for="w in entries"
      :key="w.viewId"
      data-testid="widget-card"
      class="flex min-w-0 flex-1 basis-60 self-stretch flex-col gap-1.5 rounded-card border border-border bg-surface p-3"
    >
      <!-- 卡头：widgetKey 标签（mono 9px，对齐 demo M17 tool-label 规格） -->
      <div class="font-mono text-[9px] tracking-wider text-neutral-dim">{{ w.viewId }}</div>
      <!-- 卡体：guiTree 逐项交渲染协议 -->
      <GuiComponentRenderer
        v-for="(component, i) in w.entry.guiTree"
        :key="i"
        :component="component"
      />
    </div>
  </div>
</template>
