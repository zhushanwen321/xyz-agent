<script setup lang="ts">
/**
 * ViewHost（W3 · T3，C4 契约，S4 IF6 + clarify Q3 修订）——plugin view 宿主。
 *
 * 消费 S2 ViewHostStore（经注入 ViewHostSource）的 per viewId per-session
 * GuiComponent 树缓存，交 ui/src/rendering-protocol/ GuiComponentRenderer 渲染。
 *
 * 空态占位（clarify Q3）：store 无 view 时渲染 props.title（无则 fallback view-id）
 * + 等待提示文案。标题由父层（壳/P5）从 view contribution（DM1 view: {viewType; title}）
 * 或挂载点注册处取得传入，组件不查 ContributionRegistry（props 注入模式，TC4）。
 *
 * 数据源经 inject 注入（VIEW_HOST_SOURCE_KEY），壳 provide 真实实现，单测
 * global.provide mock；无注入时静默空态不崩（design-review R3）。
 */
import { computed, inject } from 'vue'
import { VIEW_HOST_SOURCE_KEY } from './view-host-source'
import GuiComponentRenderer from '../rendering-protocol/GuiComponentRenderer.vue'

const props = withDefaults(
  defineProps<{
    /** plugin view id（挂载点路由键） */
    viewId: string
    /** 所属 session */
    sessionId: string
    /** view 标题（空态占位展示）；缺省 fallback view-id */
    title?: string
  }>(),
  { title: undefined },
)

const source = inject(VIEW_HOST_SOURCE_KEY, null)

/** 当前 session + viewId 的 GuiComponent 树缓存条目（无则 undefined → 空态） */
const view = computed(() => source?.getView(props.sessionId, props.viewId))

const emptyTitle = computed(() => props.title ?? props.viewId)
</script>

<template>
  <div data-testid="view-host" class="flex min-h-0 flex-1 flex-col">
    <template v-if="view">
      <GuiComponentRenderer
        v-for="(component, i) in view.guiTree"
        :key="i"
        :component="component"
      />
    </template>
    <div
      v-else
      data-testid="view-host-empty"
      class="flex flex-col items-center justify-center gap-1 py-10 text-sm"
    >
      <span class="font-medium text-foreground">{{ emptyTitle }}</span>
      <span class="text-muted-foreground">等待插件渲染…</span>
    </div>
  </div>
</template>
