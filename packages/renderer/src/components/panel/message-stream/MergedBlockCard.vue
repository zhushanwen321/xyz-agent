<template>
  <!--
    展示组件 · merged 卡片（w2 wave）。
    连续同类 thinking/tool 块合并后的可展开卡片：header 汇总文案 + 展开后 items 列表。
    从 Turn.vue 抽出（保持 Turn.vue ≤500 行 eslint max-lines 规范）。

    样式：border-l-2 + soft 底色（tool=info / thinking=reasoning），点击 toggle 本地 expanded。
    expanded 态本地管理（merged 卡是 trace 内次级折叠，与 turn 级 rail toggle 语义不同）。
  -->
  <div
    class="merged-card my-1 rounded-md border-l-2 px-2 py-1 transition-colors"
    :class="[
      blk.type === 'tool'
        ? 'border-info bg-info-soft hover:bg-info-soft'
        : 'border-reasoning bg-reasoning-soft hover:bg-reasoning-soft',
    ]"
    role="button"
    tabindex="0"
    data-testid="merged-block-card"
    :aria-expanded="expanded"
  >
    <div
      class="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em]"
      :class="blk.type === 'tool' ? 'text-info' : 'text-reasoning'"
      @click="expanded = !expanded"
      @keydown.enter.prevent="expanded = !expanded"
      @keydown.space.prevent="expanded = !expanded"
    >
      <ChevronRight class="size-2.5 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''" />
      <component :is="blk.type === 'tool' ? Wrench : Brain" class="size-3 shrink-0" />
      <span class="normal-case tracking-normal">{{ summary }}</span>
    </div>
    <!-- 展开后：items 列表（每个 item 渲染独立 Block） -->
    <div v-if="expanded" class="mt-1 flex flex-col gap-0.5">
      <Block
        v-for="(item, iIdx) in blk.items"
        :key="`${blk.type}-${iIdx}`"
        :type="item.kind"
        :content="item.kind === 'thinking' ? (item.ref as ThinkingBlock).content : undefined"
        :tool="item.kind === 'tool' ? (item.ref as ToolCall) : undefined"
        :collapsed="item.kind === 'thinking' ? (item.ref as ThinkingBlock).collapsed : undefined"
        :working="working"
        :session-id="sessionId"
        :force-expand="true"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * script：本地 expanded 态 + 汇总文案（i18n tool/thinking 按 items 数）。
 * 无副作用，纯展示 + 本地折叠态。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Brain, ChevronRight, Wrench } from '@lucide/vue'
import type { MergedBlockGroup } from '@/composables/logic/mergeBlocks'
import type { ThinkingBlock, ToolCall } from '@xyz-agent/shared'
import Block from './Block.vue'

const props = defineProps<{
  /** 合并组（连续同类 thinking/tool，items.length >= 2） */
  blk: MergedBlockGroup
  /** 父 turn 是否进行中（透传给内部 Block 的 working prop） */
  working: boolean
  /** session id（透传给内部 Block） */
  sessionId: string
}>()

const { t } = useI18n()

/** 本地展开态（merged 卡次级折叠，不进 useTurnExpansion）。working 时默认展开，流式可见。 */
const expanded = ref(props.working)
watch(
  () => props.working,
  (w) => {
    if (w) expanded.value = true
  },
)

/** 汇总文案：tool 用 mergedTools i18n，thinking 用 mergedThoughts */
const summary = computed(() =>
  props.blk.type === 'tool'
    ? t('panel.message.mergedTools', { n: props.blk.items.length })
    : t('panel.message.mergedThoughts', { n: props.blk.items.length }),
)
</script>
